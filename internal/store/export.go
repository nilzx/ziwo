package store

import (
	"bufio"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"time"
)

// An export is the event log and what the memories say, one JSON object per
// line: a header, one line per event, a footer. Each event line carries a
// hash chained to the one before, and the footer repeats the last, so a file
// that was cut short or changed is noticed when it is brought back. Derived
// tables and vectors are left out; they are rebuilt.
const exportVersion = 1

// ErrBadExport is returned when an export cannot be brought back as it is.
var ErrBadExport = errors.New("not a usable export")

type exportHeader struct {
	Version    int    `json:"ziwo_export"`
	LogFormat  int    `json:"log_format"`
	Instance   string `json:"instance"`
	ExportedAt int64  `json:"exported_at"` // unix milliseconds
}

type exportEvent struct {
	Seq     int64           `json:"seq"`
	At      int64           `json:"at"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
	Content *string         `json:"content,omitempty"` // what a memory says, for a remember event that still has it
	Chain   string          `json:"chain"`
}

type exportFooter struct {
	End       bool   `json:"end"`
	Events    int64  `json:"events"`
	Head      string `json:"head"`
	TokenHash string `json:"token_sha256,omitempty"`
}

type restoreEvent struct {
	From       string `json:"from,omitempty"` // instance the export was made from
	ExportedAt int64  `json:"exported_at"`
	Events     int64  `json:"events"`
}

// RestoreNote says that a memory was brought back from an export.
type RestoreNote struct {
	At         time.Time // when it was brought back
	ExportedAt time.Time // when the export was made
}

func chain(prev string, e exportEvent) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s\n%d\n%d\n%s\n", prev, e.Seq, e.At, e.Kind)
	h.Write(e.Payload)
	if e.Content != nil {
		h.Write([]byte{'\n'})
		h.Write([]byte(*e.Content))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// Export writes the memory to w and reports how many events it wrote. It
// reads one consistent state, also while the memory is being served. It
// works on a store opened with LogOnly.
func (s *Store) Export(ctx context.Context, w io.Writer, at time.Time) (events int64, err error) {
	tx, err := s.r.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	instance, _, err := getMeta(ctx, tx, metaInstance)
	if err != nil {
		return 0, err
	}
	token, _, err := getMeta(ctx, tx, metaTokenHash)
	if err != nil {
		return 0, err
	}
	out := bufio.NewWriter(w)
	enc := json.NewEncoder(out)
	if err := enc.Encode(exportHeader{Version: exportVersion, LogFormat: logFormat, Instance: instance, ExportedAt: at.UnixMilli()}); err != nil {
		return 0, err
	}
	rows, err := tx.QueryContext(ctx,
		`SELECT e.seq, e.at, e.kind, e.payload, c.data
		   FROM events e LEFT JOIN contents c ON e.kind = 'remember' AND c.id = json_extract(e.payload, '$.id')
		  ORDER BY e.seq`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	head := ""
	for rows.Next() {
		var e exportEvent
		var payload string
		var data sql.NullString
		if err := rows.Scan(&e.Seq, &e.At, &e.Kind, &payload, &data); err != nil {
			return 0, err
		}
		e.Payload = json.RawMessage(payload)
		if data.Valid {
			e.Content = &data.String
		}
		head = chain(head, e)
		e.Chain = head
		if err := enc.Encode(e); err != nil {
			return 0, err
		}
		events++
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if err := enc.Encode(exportFooter{End: true, Events: events, Head: head, TokenHash: token}); err != nil {
		return 0, err
	}
	return events, out.Flush()
}

// ImportStats says what an import brought back.
type ImportStats struct {
	Events     int64
	Memories   int64
	ExportedAt time.Time
	HasToken   bool // the memory answers to the token it had when it was exported
}

// Import makes a new memory file at path from an export read from r. The file
// must not exist. The whole export is checked before anything is kept: on any
// fault the file is removed. The new memory's log records that it was brought
// back, and from an export of when, so that it can be told from the memory
// the export was made of.
func Import(ctx context.Context, path string, r io.Reader, at time.Time) (st ImportStats, err error) {
	if _, serr := os.Stat(path); serr == nil {
		return st, fmt.Errorf("%s already exists", path)
	} else if !errors.Is(serr, os.ErrNotExist) {
		return st, serr
	}
	defer func() {
		if err != nil {
			for _, suffix := range []string{"", "-wal", "-shm"} {
				os.Remove(path + suffix)
			}
		}
	}()

	in := bufio.NewReaderSize(r, 1<<20)
	line := func(v any) error {
		b, err := in.ReadBytes('\n')
		if err != nil && (err != io.EOF || len(b) == 0) {
			return fmt.Errorf("%w: it ends early", ErrBadExport)
		}
		if err := json.Unmarshal(b, v); err != nil {
			return fmt.Errorf("%w: unreadable line", ErrBadExport)
		}
		return nil
	}
	var head exportHeader
	if err := line(&head); err != nil {
		return st, err
	}
	switch {
	case head.Version != exportVersion:
		return st, fmt.Errorf("%w: it is not a ziwo export of a kind this build reads", ErrBadExport)
	case head.LogFormat > logFormat:
		return st, fmt.Errorf("%w: its log format is %d, this build reads up to %d", ErrNewerFormat, head.LogFormat, logFormat)
	}
	st.ExportedAt = time.UnixMilli(head.ExportedAt).UTC()

	s, err := Open(ctx, path, Options{Create: true, LogOnly: true})
	if err != nil {
		return st, err
	}
	var foot exportFooter
	err = s.write(ctx, func(tx *sql.Tx) error {
		prev := ""
		for {
			var raw json.RawMessage
			if err := line(&raw); err != nil {
				return err
			}
			if err := json.Unmarshal(raw, &foot); err == nil && foot.End {
				break
			}
			var e exportEvent
			if err := json.Unmarshal(raw, &e); err != nil || e.Kind == "" {
				return fmt.Errorf("%w: unreadable event", ErrBadExport)
			}
			if prev = chain(prev, e); prev != e.Chain {
				return fmt.Errorf("%w: it was changed or damaged at event %d", ErrBadExport, e.Seq)
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO events(seq, at, kind, payload) VALUES(?, ?, ?, ?)`,
				e.Seq, e.At, e.Kind, string(e.Payload)); err != nil {
				return fmt.Errorf("%w: event %d: %v", ErrBadExport, e.Seq, err)
			}
			st.Events++
			if e.Kind != kindRemember {
				continue
			}
			st.Memories++
			if e.Content != nil {
				var id string
				if err := tx.QueryRowContext(ctx, `SELECT json_extract(?, '$.id')`, string(e.Payload)).Scan(&id); err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `INSERT INTO contents(id, data) VALUES(?, ?)`, id, *e.Content); err != nil {
					return fmt.Errorf("%w: event %d: %v", ErrBadExport, e.Seq, err)
				}
			}
		}
		if foot.Events != st.Events || foot.Head != prev {
			return fmt.Errorf("%w: it is incomplete: it holds %d events and says %d", ErrBadExport, st.Events, foot.Events)
		}
		// The log is in the format the export was written in. Reopening
		// upgrades it if this build is newer.
		if err := setMeta(ctx, tx, metaLogFormat, strconv.Itoa(head.LogFormat)); err != nil {
			return err
		}
		if foot.TokenHash != "" {
			st.HasToken = true
			return setMeta(ctx, tx, metaTokenHash, foot.TokenHash)
		}
		return nil
	})
	if cerr := s.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return st, err
	}

	if s, err = Open(ctx, path, Options{LogOnly: true}); err != nil {
		return st, err
	}
	defer s.Close()
	payload, err := json.Marshal(restoreEvent{From: head.Instance, ExportedAt: head.ExportedAt, Events: st.Events})
	if err != nil {
		return st, err
	}
	_, err = s.w.ExecContext(ctx, `INSERT INTO events(at, kind, payload) VALUES(?, ?, ?)`, at.UnixMilli(), kindRestore, string(payload))
	return st, err
}

// LastRestore reports the most recent time this memory was brought back from
// an export, if it ever was.
func (s *Store) LastRestore(ctx context.Context) (RestoreNote, bool, error) {
	var at, exported int64
	err := s.r.QueryRowContext(ctx, `SELECT at, exported_at FROM restores ORDER BY at DESC LIMIT 1`).Scan(&at, &exported)
	if errors.Is(err, sql.ErrNoRows) {
		return RestoreNote{}, false, nil
	}
	if err != nil {
		return RestoreNote{}, false, err
	}
	return RestoreNote{At: time.UnixMilli(at).UTC(), ExportedAt: time.UnixMilli(exported).UTC()}, true, nil
}

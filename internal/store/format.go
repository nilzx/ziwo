package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
)

// ErrNewerFormat is returned when a file's event log was written in a format
// this build does not know. Opening it anyway could misread or damage it.
var ErrNewerFormat = errors.New("written by a newer version of ziwo")

// migrations[v] rewrites a log from format v to format v+1. Each runs once,
// inside the transaction that lifts the append-only triggers.
var migrations = []func(context.Context, *sql.Tx) error{
	// 0 -> 1: reading a memory in full becomes its own kind of event.
	func(ctx context.Context, tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx,
			`UPDATE events SET kind = 'expand', payload = json_remove(payload, '$.query')
			  WHERE kind = 'recall' AND COALESCE(json_extract(payload, '$.query'), '') = ''`)
		return err
	},
	// 1 -> 2: what a memory says moves out of its event into the contents
	// table, so that it can be erased. The event keeps the content's hash.
	func(ctx context.Context, tx *sql.Tx) error {
		type row struct {
			seq     int64
			payload string
		}
		var after int64
		for {
			rows, err := tx.QueryContext(ctx,
				`SELECT seq, payload FROM events WHERE kind = 'remember' AND seq > ? ORDER BY seq LIMIT 200`, after)
			if err != nil {
				return err
			}
			var batch []row
			for rows.Next() {
				var r row
				if err := rows.Scan(&r.seq, &r.payload); err != nil {
					rows.Close()
					return err
				}
				batch = append(batch, r)
			}
			if err := errors.Join(rows.Err(), rows.Close()); err != nil {
				return err
			}
			if len(batch) == 0 {
				return nil
			}
			for _, r := range batch {
				var old rememberEventV1
				if err := json.Unmarshal([]byte(r.payload), &old); err != nil {
					return fmt.Errorf("event %d: %w", r.seq, err)
				}
				if old.Hash != "" {
					continue // already in the new form
				}
				data, hash := content{Gist: old.Gist, Body: old.Body, Outcome: old.Outcome, Feeling: old.Feeling,
					Lesson: old.Lesson, People: old.People, Pointer: old.Pointer}.encode()
				if _, err := tx.ExecContext(ctx,
					`INSERT INTO contents(id, data) VALUES(?, ?) ON CONFLICT(id) DO NOTHING`, old.ID, data); err != nil {
					return err
				}
				slim, err := json.Marshal(rememberEvent{ID: old.ID, Session: old.Session, Moment: old.Moment,
					Source: old.Source, Importance: old.Importance, Intensity: old.Intensity, Hash: hash})
				if err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `UPDATE events SET payload = ? WHERE seq = ?`, string(slim), r.seq); err != nil {
					return err
				}
			}
			after = batch[len(batch)-1].seq
		}
	},
}

// rememberEventV1 is a remember event as formats 0 and 1 wrote it, with what
// the memory says inside the event.
type rememberEventV1 struct {
	ID         string   `json:"id"`
	Session    string   `json:"session"`
	Moment     string   `json:"moment"`
	Source     string   `json:"source"`
	Importance float64  `json:"importance"`
	Intensity  float64  `json:"intensity,omitempty"`
	Gist       string   `json:"gist"`
	Body       string   `json:"body"`
	Outcome    string   `json:"outcome,omitempty"`
	Feeling    string   `json:"feeling,omitempty"`
	Lesson     string   `json:"lesson,omitempty"`
	People     []string `json:"people,omitempty"`
	Pointer    string   `json:"pointer,omitempty"`
	Hash       string   `json:"hash,omitempty"` // set only by later formats
}

// upgradeLog brings the event log to the current format. It reports whether
// it changed anything, in which case the derived tables are stale.
func (s *Store) upgradeLog(ctx context.Context) (migrated bool, err error) {
	err = s.write(ctx, func(tx *sql.Tx) error {
		have, set, err := getMeta(ctx, tx, metaLogFormat)
		if err != nil {
			return err
		}
		format := 0 // a log with events and no recorded format predates versioning
		if set {
			if format, err = strconv.Atoi(have); err != nil {
				return fmt.Errorf("unreadable log format %q", have)
			}
		} else {
			var events int64
			if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM events`).Scan(&events); err != nil {
				return err
			}
			if events == 0 {
				return setMeta(ctx, tx, metaLogFormat, strconv.Itoa(logFormat))
			}
		}
		switch {
		case format > logFormat:
			return fmt.Errorf("%w: its log format is %d, this build reads up to %d", ErrNewerFormat, format, logFormat)
		case format == logFormat:
			return nil
		}

		if _, err := tx.ExecContext(ctx, dropAppendOnlyTriggers); err != nil {
			return err
		}
		for ; format < logFormat; format++ {
			if err := migrations[format](ctx, tx); err != nil {
				return fmt.Errorf("upgrade log format %d to %d: %w", format, format+1, err)
			}
		}
		if _, err := tx.ExecContext(ctx, appendOnlyTriggers); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM meta WHERE key = ?`, metaDerived); err != nil {
			return err
		}
		migrated = true
		return setMeta(ctx, tx, metaLogFormat, strconv.Itoa(logFormat))
	})
	return migrated, err
}

// Keys of the meta table.
const (
	metaLogFormat = "log_format"
	metaDerived   = "derived"
	metaTokenHash = "token_sha256"
)

type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func getMeta(ctx context.Context, q querier, key string) (value string, ok bool, err error) {
	err = q.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return value, err == nil, err
}

func setMeta(ctx context.Context, e execer, key, value string) error {
	_, err := e.ExecContext(ctx,
		`INSERT INTO meta(key, value) VALUES(?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

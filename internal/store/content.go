package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Kinds of memory.
const (
	KindFragment = "fragment" // a moment, written as it happened
)

// Standing of a memory that is no longer live.
const (
	StateSuperseded = "superseded" // a correction replaced it
	StateErased     = "erased"     // its content was deleted for good
)

// content is what a memory says: everything in it that is prose. It is kept
// apart from the event that records the memory so that it can be erased.
type content struct {
	Gist    string   `json:"gist"`
	Body    string   `json:"body,omitempty"`
	Outcome string   `json:"outcome,omitempty"`
	Feeling string   `json:"feeling,omitempty"`
	Lesson  string   `json:"lesson,omitempty"`
	People  []string `json:"people,omitempty"`
	Pointer string   `json:"pointer,omitempty"`
}

// encode returns the stored form of the content and the hash its event keeps.
func (c content) encode() (data, hash string) {
	b, err := json.Marshal(c)
	if err != nil {
		panic(err) // strings and a slice of strings always encode
	}
	sum := sha256.Sum256(b)
	return string(b), hex.EncodeToString(sum[:])
}

// loadContent reads what the memory with the given id says. kept is false
// when the content has been erased.
func loadContent(ctx context.Context, q querier, id string) (c content, kept bool, err error) {
	var data string
	err = q.QueryRowContext(ctx, `SELECT data FROM contents WHERE id = ?`, id).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return content{}, false, nil
	}
	if err != nil {
		return content{}, false, err
	}
	return c, true, json.Unmarshal([]byte(data), &c)
}

// writeMemory stores what a new memory says and appends the event that
// records it. The event carries the content's hash, not the content.
func (s *Store) writeMemory(ctx context.Context, tx *sql.Tx, at time.Time, e rememberEvent, c content) error {
	data, hash := c.encode()
	e.Hash = hash
	if _, err := tx.ExecContext(ctx, `INSERT INTO contents(id, data) VALUES(?, ?)`, e.ID, data); err != nil {
		return err
	}
	_, err := s.appendEvent(ctx, tx, at, kindRemember, e)
	return err
}

// applyRemember projects a remember event. What the memory says is read from
// the contents table; if it has been erased, the memory is still counted,
// because it was lived through, but it says nothing.
func (s *Store) applyRemember(ctx context.Context, tx *sql.Tx, seq, at int64, e rememberEvent) error {
	c, kept, err := loadContent(ctx, tx, e.ID)
	if err != nil {
		return err
	}
	kind, state, hash := e.Kind, "", ""
	if kind == "" {
		kind = KindFragment
	}
	if kept {
		hash = contentHash(c.Gist, c.Body)
	} else {
		state = StateErased
	}
	people := c.People
	if people == nil {
		people = []string{}
	}
	pj, err := json.Marshal(people)
	if err != nil {
		return err
	}
	clock, err := clockOf(ctx, tx)
	if err != nil {
		return err
	}
	ord := clock + 1 // writing a memory is what advances the clock
	core := s.params.isCore(e.Importance, e.Intensity)
	strength := s.params.initialStrength(e.Importance, e.Intensity, e.Source)
	var fadeAt, archiveAt any // NULL for a core memory
	if !core {
		fadeAt, archiveAt = s.params.crossings(ord, strength)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO memories(n, id, created_at, session_id, kind, moment, source, importance, intensity,
		   gist, body, outcome, feeling, lesson, people, pointer, hash, last_recalled_at, recall_count,
		   ord, touched_ord, read_ord, core, strength, fade_at, archive_at,
		   state, state_by, retracted, pinned, corrects)
		 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, 0, ?)`,
		seq, e.ID, at, e.Session, kind, e.Moment, e.Source, e.Importance, e.Intensity,
		c.Gist, c.Body, c.Outcome, c.Feeling, c.Lesson, string(pj), c.Pointer, hash, at,
		ord, ord, ord, core, strength, fadeAt, archiveAt, state, e.Corrects); err != nil {
		return err
	}
	if kept {
		rest := strings.Join(append([]string{c.Body, c.Outcome, c.Feeling, c.Lesson, c.Pointer}, people...), "\n")
		if _, err := tx.ExecContext(ctx, `INSERT INTO memories_fts(rowid, gist, rest) VALUES(?, ?, ?)`,
			seq, indexText(c.Gist), indexText(rest)); err != nil {
			return err
		}
	}
	if e.Corrects != "" {
		// The memory it corrects stays in the record and leaves ordinary recall.
		if _, err := tx.ExecContext(ctx,
			`UPDATE memories SET state = ?, state_by = ? WHERE id = ? AND state = ''`,
			StateSuperseded, e.ID, e.Corrects); err != nil {
			return err
		}
	}
	return sessionActive(ctx, tx, e.Session, at)
}

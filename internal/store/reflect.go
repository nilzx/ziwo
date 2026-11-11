package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

var (
	// ErrReflectBusy is returned when another session holds the round of
	// reflection. Two sessions reflecting at once would put the same
	// fragments together twice.
	ErrReflectBusy = errors.New("another conversation is reflecting")
	// ErrNoBatch is returned when the batch being written back is not the
	// one that is open.
	ErrNoBatch = errors.New("that batch is not open")
)

// Entry is one memory that a round of reflection writes back.
type Entry struct {
	Kind       string // KindEpisode, KindLesson, KindImpression, KindSelf or KindReading
	Gist       string
	Body       string
	Outcome    string
	Feeling    string
	Intensity  float64
	Lesson     string
	People     []string
	Pointer    string
	Importance float64
	About      string   // impression: who or what it is about
	Context    string   // self: the situation the statement holds in
	From       []string // ids of the memories it is built on
	Ref        string   // self: the statement it revises; reading: the memory it reads
	Milestone  bool     // episode: a milestone, kept for good
}

// EntryError says which entry of a write-back cannot be written, and why, in
// words meant for whoever wrote it.
type EntryError struct {
	Index int // position in the entries, from 0
	Msg   string
}

func (e *EntryError) Error() string { return fmt.Sprintf("entry %d: %s", e.Index+1, e.Msg) }

// Rules for a statement about oneself. They are starting values.
const (
	// selfMinSources is how many experiences a new statement must rest on.
	selfMinSources = 3
	// selfMinOrigins is how many separate occasions those must come from.
	selfMinOrigins = 2
	// selfMinNew is how many experiences a revision must add to the ones the
	// statement it revises already rests on.
	selfMinNew = 2
)

type reflectEvent struct {
	Session string   `json:"session"`
	Batch   string   `json:"batch"`
	Passed  []string `json:"passed,omitempty"` // fragments looked at and left as they are
	Wrote   []string `json:"wrote,omitempty"`  // ids of the memories written back
}

// lease is the open round of reflection. It is working state, not memory, so
// it lives in meta and not in the log.
type lease struct {
	Batch   string `json:"batch"`
	Session string `json:"session"`
	Until   int64  `json:"until"` // unix milliseconds
}

const metaReflect = "reflect"

func readLease(ctx context.Context, q querier) (l lease, ok bool, err error) {
	v, ok, err := getMeta(ctx, q, metaReflect)
	if err != nil || !ok {
		return lease{}, false, err
	}
	return l, true, json.Unmarshal([]byte(v), &l)
}

// BeginReflect opens a round of reflection for the session and returns its
// batch id. Only one round is open at a time: while another session's round
// has not run out, it returns ErrReflectBusy and when that round ends.
func (s *Store) BeginReflect(ctx context.Context, at time.Time, session string, hold time.Duration) (batch string, busyUntil time.Time, err error) {
	batch = newID("b_")
	err = s.write(ctx, func(tx *sql.Tx) error {
		if err := needSession(ctx, tx, session); err != nil {
			return err
		}
		cur, ok, err := readLease(ctx, tx)
		if err != nil {
			return err
		}
		if ok && cur.Session != session && cur.Until > at.UnixMilli() {
			busyUntil = time.UnixMilli(cur.Until).UTC()
			return ErrReflectBusy
		}
		b, err := json.Marshal(lease{Batch: batch, Session: session, Until: at.Add(hold).UnixMilli()})
		if err != nil {
			return err
		}
		return setMeta(ctx, tx, metaReflect, string(b))
	})
	if err != nil {
		return "", busyUntil, err
	}
	return batch, time.Time{}, nil
}

// FinishReflect writes a round of reflection back: the entries become
// memories, the passed fragments are marked as looked at, and the round is
// closed. Nothing is written unless everything can be. It returns the ids of
// the new memories, in the order of the entries.
func (s *Store) FinishReflect(ctx context.Context, at time.Time, session, batch string, entries []Entry, passed []string) (ids []string, err error) {
	for attempt := 0; ; attempt++ {
		ids = ids[:0]
		err = s.write(ctx, func(tx *sql.Tx) error {
			if err := needSession(ctx, tx, session); err != nil {
				return err
			}
			cur, ok, err := readLease(ctx, tx)
			if err != nil {
				return err
			}
			if !ok || cur.Batch != batch || cur.Session != session {
				return ErrNoBatch
			}
			// Check everything against the memory as it stands before any of
			// it is written.
			sources := make([]string, len(entries))
			for i, e := range entries {
				if sources[i], err = checkEntry(ctx, tx, e); err != nil {
					var ee *EntryError
					if errors.As(err, &ee) {
						ee.Index = i
					}
					return err
				}
			}
			for i, e := range entries {
				id := newID("m_")
				ids = append(ids, id)
				if err := s.writeMemory(ctx, tx, at, rememberEvent{
					ID: id, Session: session, Kind: e.Kind, Source: sources[i],
					Importance: e.Importance, Intensity: e.Intensity,
					From: e.From, Ref: e.Ref, Milestone: e.Milestone,
				}, content{Gist: e.Gist, Body: e.Body, Outcome: e.Outcome, Feeling: e.Feeling, Lesson: e.Lesson,
					People: e.People, Pointer: e.Pointer, About: e.About, Context: e.Context}); err != nil {
					return err
				}
			}
			if _, err := s.appendEvent(ctx, tx, at, kindReflect,
				reflectEvent{Session: session, Batch: batch, Passed: passed, Wrote: ids}); err != nil {
				return err
			}
			_, err = tx.ExecContext(ctx, `DELETE FROM meta WHERE key = ?`, metaReflect)
			return err
		})
		if err == nil {
			return ids, nil
		}
		if !isConstraint(err) || attempt >= 3 {
			return nil, err
		}
	}
}

// AbandonReflect closes a round without writing anything back, if it is
// still the one that is open.
func (s *Store) AbandonReflect(ctx context.Context, session, batch string) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		cur, ok, err := readLease(ctx, tx)
		if err != nil || !ok || cur.Batch != batch || cur.Session != session {
			return err
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM meta WHERE key = ?`, metaReflect)
		return err
	})
}

// basis is a memory that an entry rests on, as far as the checks need it.
type basis struct {
	id, kind, state, source, session string
	retracted                        bool
	happened                         int64
}

func loadBasis(ctx context.Context, tx *sql.Tx, id string) (basis, error) {
	b := basis{id: id}
	err := tx.QueryRowContext(ctx,
		`SELECT kind, state, source, session_id, retracted, created_at FROM memories WHERE id = ?`, id).
		Scan(&b.kind, &b.state, &b.source, &b.session, &b.retracted, &b.happened)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return b, &EntryError{Msg: fmt.Sprintf("%s names no memory", id)}
	case err != nil:
		return b, err
	case b.state == StateErased:
		return b, &EntryError{Msg: fmt.Sprintf("%s has been erased", id)}
	case b.retracted:
		return b, &EntryError{Msg: fmt.Sprintf("%s has been retracted", id)}
	}
	return b, nil
}

// origin names the occasion a lived or reconstructed experience belongs to:
// the conversation it was written in, or the day it happened if it was
// reconstructed afterwards.
func (b basis) origin() string {
	if b.source == SourceReconstructed {
		return "day " + time.UnixMilli(b.happened).UTC().Format(time.DateOnly)
	}
	return b.session
}

// checkEntry checks an entry against the memory as it stands and returns the
// source the new memory is to carry.
func checkEntry(ctx context.Context, tx *sql.Tx, e Entry) (source string, err error) {
	if e.Kind == KindReading {
		if _, err := loadBasis(ctx, tx, e.Ref); err != nil {
			return "", err
		}
		return "inferred", nil // an understanding of an experience, not the experience
	}

	var from []basis
	seen := make(map[string]bool)
	for _, id := range e.From {
		if seen[id] {
			continue
		}
		seen[id] = true
		b, err := loadBasis(ctx, tx, id)
		if err != nil {
			return "", err
		}
		switch {
		case e.Kind == KindEpisode && (b.kind != KindFragment || b.state != ""):
			return "", &EntryError{Msg: fmt.Sprintf("%s cannot go into an episode: an episode is put together from fragments that are not part of one yet", id)}
		case b.kind != KindFragment && b.kind != KindEpisode:
			return "", &EntryError{Msg: fmt.Sprintf("%s is a %s: build on what was lived through, fragments and episodes", id, b.kind)}
		case b.state == StateSuperseded:
			return "", &EntryError{Msg: fmt.Sprintf("%s has been replaced by a correction: build on the correction", id)}
		}
		from = append(from, b)
	}
	if len(from) == 0 {
		return "", &EntryError{Msg: "from is required: the ids of the memories this rests on"}
	}
	source = from[0].source
	for _, b := range from {
		if b.source != source {
			source = "lived"
		}
	}
	if e.Kind != KindSelf {
		return source, nil
	}

	// A statement about oneself rests on what was lived through, on several
	// separate occasions. What others said, and what was inferred, is no basis.
	origins := make(map[string]bool)
	for _, b := range from {
		if b.source != "lived" && b.source != SourceReconstructed {
			return "", &EntryError{Msg: fmt.Sprintf("%s is something you were told or inferred: a statement about yourself rests on what you lived through", b.id)}
		}
		if b.kind == KindFragment {
			origins[b.origin()] = true
			continue
		}
		rows, err := tx.QueryContext(ctx,
			`SELECT m.source, m.session_id, m.created_at FROM links l JOIN memories m ON m.id = l.dst WHERE l.src = ?`, b.id)
		if err != nil {
			return "", err
		}
		for rows.Next() {
			var part basis
			if err := rows.Scan(&part.source, &part.session, &part.happened); err != nil {
				rows.Close()
				return "", err
			}
			origins[part.origin()] = true
		}
		if err := errors.Join(rows.Err(), rows.Close()); err != nil {
			return "", err
		}
	}
	if e.Ref == "" {
		if len(from) < selfMinSources || len(origins) < selfMinOrigins {
			return "", &EntryError{Msg: fmt.Sprintf("a statement about yourself needs at least %d experiences from at least %d separate occasions; this rests on %d from %d. Leave it until it has shown up more often",
				selfMinSources, selfMinOrigins, len(from), len(origins))}
		}
		return "lived", nil
	}
	var kind, state string
	err = tx.QueryRowContext(ctx, `SELECT kind, state FROM memories WHERE id = ? AND retracted = 0`, e.Ref).Scan(&kind, &state)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (kind != KindSelf || state != "")) {
		return "", &EntryError{Msg: fmt.Sprintf("%s is not a statement about yourself that stands: ref must name the one being revised", e.Ref)}
	}
	if err != nil {
		return "", err
	}
	fresh := 0
	for _, b := range from {
		var cited int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM links WHERE src = ? AND dst = ?`, e.Ref, b.id).Scan(&cited); err != nil {
			return "", err
		}
		if cited == 0 {
			fresh++
		}
	}
	if fresh < selfMinNew {
		return "", &EntryError{Msg: fmt.Sprintf("a revision needs at least %d experiences the statement does not already rest on; this adds %d", selfMinNew, fresh)}
	}
	return "lived", nil
}

// applyReflect marks the fragments a round passed over. Having been looked at
// and found not worth keeping together with anything, they leave ordinary
// recall sooner than they otherwise would, unless they come to mind again.
func (s *Store) applyReflect(ctx context.Context, tx *sql.Tx, at int64, e reflectEvent) error {
	clock, err := clockOf(ctx, tx)
	if err != nil {
		return err
	}
	limit := float64(clock) + s.params.BaseStrength/2
	for _, id := range e.Passed {
		if _, err := tx.ExecContext(ctx,
			`UPDATE memories SET reviewed = ?, fade_at = MIN(fade_at, ?), archive_at = MIN(archive_at, ?)
			  WHERE id = ? AND kind = ? AND state = '' AND reviewed IS NULL`,
			clock, limit, limit, id, KindFragment); err != nil {
			return err
		}
	}
	return sessionActive(ctx, tx, e.Session, at)
}

// Pending returns up to limit fragments that reflect has not dealt with,
// those nearest to fading first.
func (s *Store) Pending(ctx context.Context, limit int) ([]Memory, error) {
	return s.memories(ctx, `WHERE m.kind = ? AND `+isLive+` AND m.reviewed IS NULL
		ORDER BY m.core, m.fade_at, m.n LIMIT ?`, KindFragment, limit)
}

// PendingCount reports how many fragments wait for reflect.
func (s *Store) PendingCount(ctx context.Context) (int64, error) {
	var n int64
	err := s.r.QueryRowContext(ctx,
		`SELECT count(*) FROM memories m WHERE m.kind = ? AND `+isLive+` AND m.reviewed IS NULL`, KindFragment).Scan(&n)
	return n, err
}

// Selves returns the statements about oneself that stand, oldest first.
func (s *Store) Selves(ctx context.Context) ([]Memory, error) {
	return s.memories(ctx, `WHERE m.kind = ? AND `+isLive+` ORDER BY m.n`, KindSelf)
}

// Impressions returns the current impression of each of the named people or
// things that has one.
func (s *Store) Impressions(ctx context.Context, names []string) ([]Memory, error) {
	if len(names) == 0 {
		return nil, nil
	}
	args := []any{KindImpression}
	for _, n := range names {
		args = append(args, n)
	}
	return s.memories(ctx, `WHERE m.kind = ? AND `+isLive+` AND m.about IN (`+placeholders(len(names))+`) ORDER BY m.about`, args...)
}

// Readings returns the later understandings of the memory with the given id,
// oldest first.
func (s *Store) Readings(ctx context.Context, id string) ([]Memory, error) {
	return s.memories(ctx, `WHERE m.kind = ? AND `+isLive+` AND m.ref = ? ORDER BY m.n`, KindReading, id)
}

// Sources returns the ids of the memories that the one with the given id is
// built on.
func (s *Store) Sources(ctx context.Context, id string) ([]string, error) {
	rows, err := s.r.QueryContext(ctx,
		`SELECT l.dst FROM links l JOIN memories m ON m.id = l.dst WHERE l.src = ? ORDER BY m.n`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var dst string
		if err := rows.Scan(&dst); err != nil {
			return nil, err
		}
		out = append(out, dst)
	}
	return out, rows.Err()
}

package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"time"
)

// What Amend can do to a memory.
const (
	AmendRetract = "retract" // set aside: kept in the record, no longer recalled
	AmendRestore = "restore" // undo a retraction
	AmendPin     = "pin"     // keep as core, whatever its importance
	AmendUnpin   = "unpin"
	AmendReweigh = "reweigh" // change its importance

	amendPrefer   = "prefer"   // set a standing rule about what to remember
	amendUnprefer = "unprefer" // retire one
)

var (
	// ErrNoMemory is returned for an id that names no memory.
	ErrNoMemory = errors.New("no such memory")
	// ErrErased is returned when a memory's content is gone and the request
	// needs it.
	ErrErased = errors.New("the memory has been erased")
	// ErrSuperseded is returned when a correction has already replaced the memory.
	ErrSuperseded = errors.New("the memory has been replaced by a correction")
	// ErrNoPreference is returned for an id that names no preference in force.
	ErrNoPreference = errors.New("no such preference")
	// ErrTooManyPreferences is returned when no more preferences fit.
	ErrTooManyPreferences = errors.New("too many preferences")
)

type amendEvent struct {
	Session    string  `json:"session"`
	Action     string  `json:"action"`
	ID         string  `json:"id"`               // a memory; a preference for prefer and unprefer
	Importance float64 `json:"importance"`       // for reweigh
	Text       string  `json:"text,omitempty"`   // the preference, for prefer
	Reason     string  `json:"reason,omitempty"` // why it was asked for
}

type eraseEvent struct {
	Session string `json:"session"`
	ID      string `json:"id"`
	Reason  string `json:"reason,omitempty"`
}

// Preference is a standing rule about what to remember, set in conversation.
type Preference struct {
	ID        string
	CreatedAt time.Time
	Text      string
}

func needSession(ctx context.Context, tx *sql.Tx, id string) error {
	var known int
	err := tx.QueryRowContext(ctx, `SELECT 1 FROM sessions WHERE id = ?`, id).Scan(&known)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("%w: %q", ErrNoSession, id)
	}
	return err
}

// standing reads where a memory stands, or says why it cannot be acted on.
func standing(ctx context.Context, tx *sql.Tx, id string) (n int64, kind, state, stateBy string, err error) {
	err = tx.QueryRowContext(ctx, `SELECT n, kind, state, state_by FROM memories WHERE id = ?`, id).Scan(&n, &kind, &state, &stateBy)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		err = fmt.Errorf("%w: %q", ErrNoMemory, id)
	case err == nil && state == StateErased:
		err = ErrErased
	}
	return n, kind, state, stateBy, err
}

// Amend changes a memory's standing or weight: action is one of the Amend
// constants, and importance is used by AmendReweigh alone. The memory itself
// is not rewritten; the change is one more event. Being amended counts as
// coming to mind, so the memory's decay starts over.
func (s *Store) Amend(ctx context.Context, at time.Time, session, action, id string, importance float64, reason string) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		if err := needSession(ctx, tx, session); err != nil {
			return err
		}
		_, _, state, stateBy, err := standing(ctx, tx, id)
		if err != nil {
			return err
		}
		switch action {
		case AmendRetract, AmendRestore:
		case AmendPin, AmendUnpin, AmendReweigh:
			if state == StateSuperseded {
				return fmt.Errorf("%w: %s", ErrSuperseded, stateBy)
			}
		default:
			return fmt.Errorf("unknown amend action %q", action)
		}
		_, err = s.appendEvent(ctx, tx, at, kindAmend, amendEvent{
			Session: session, Action: action, ID: id, Importance: importance, Reason: reason})
		return err
	})
}

// Correct writes a memory that replaces the one with id old, and returns the
// new memory's id. The old one stays in the record, marked as replaced, and
// leaves ordinary recall. The new one is of the same kind.
func (s *Store) Correct(ctx context.Context, at time.Time, old string, in RememberInput) (id string, err error) {
	for attempt := 0; ; attempt++ {
		id = newID("m_")
		err = s.write(ctx, func(tx *sql.Tx) error {
			if err := needSession(ctx, tx, in.SessionID); err != nil {
				return err
			}
			_, kind, state, stateBy, err := standing(ctx, tx, old)
			if err != nil {
				return err
			}
			if state == StateSuperseded {
				return fmt.Errorf("%w: %s", ErrSuperseded, stateBy)
			}
			if kind == KindFragment {
				kind = ""
			}
			return s.writeMemory(ctx, tx, at, rememberEvent{
				ID: id, Session: in.SessionID, Kind: kind, Moment: in.Moment, Source: in.Source,
				Importance: in.Importance, Intensity: in.Intensity, Corrects: old,
			}, in.content())
		})
		if err == nil {
			return id, nil
		}
		if !isConstraint(err) || attempt >= 3 {
			return "", err
		}
	}
}

// Erase deletes what a memory says, for good. The log keeps the fact that the
// memory existed and that it was erased, and the memory keeps its place in
// the count of what was lived through. It returns the memory's row number so
// the caller can drop it from indexes of its own.
func (s *Store) Erase(ctx context.Context, at time.Time, session, id, reason string) (n int64, err error) {
	err = s.write(ctx, func(tx *sql.Tx) error {
		if err := needSession(ctx, tx, session); err != nil {
			return err
		}
		if n, _, _, _, err = standing(ctx, tx, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM contents WHERE id = ?`, id); err != nil {
			return err
		}
		if _, err := s.appendEvent(ctx, tx, at, kindErase, eraseEvent{Session: session, ID: id, Reason: reason}); err != nil {
			return err
		}
		// The keyword index keeps the words of a deleted row until its
		// segments are merged. Merge them now.
		_, err := tx.ExecContext(ctx, `INSERT INTO memories_fts(memories_fts) VALUES('optimize')`)
		return err
	})
	if err != nil {
		return 0, err
	}
	// The write-ahead log still holds the pages as they were. Fold it into
	// the file, where deleted content is overwritten. If a reader is in the
	// way this does nothing, and the next checkpoint does it.
	_, _ = s.w.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`)
	return n, nil
}

// AddPreference records a standing rule about what to remember and returns
// its id. At most max preferences can be in force.
func (s *Store) AddPreference(ctx context.Context, at time.Time, session, text string, max int) (id string, err error) {
	for attempt := 0; ; attempt++ {
		id = newID("p_")
		err = s.write(ctx, func(tx *sql.Tx) error {
			if err := needSession(ctx, tx, session); err != nil {
				return err
			}
			var inForce int
			if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM policies WHERE retired_at IS NULL`).Scan(&inForce); err != nil {
				return err
			}
			if inForce >= max {
				return ErrTooManyPreferences
			}
			_, err := s.appendEvent(ctx, tx, at, kindAmend, amendEvent{Session: session, Action: amendPrefer, ID: id, Text: text})
			return err
		})
		if err == nil {
			return id, nil
		}
		if !isConstraint(err) || attempt >= 3 {
			return "", err
		}
	}
}

// RetirePreference takes a preference out of force. It stays in the log.
func (s *Store) RetirePreference(ctx context.Context, at time.Time, session, id, reason string) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		if err := needSession(ctx, tx, session); err != nil {
			return err
		}
		var known int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM policies WHERE id = ? AND retired_at IS NULL`, id).Scan(&known)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("%w: %q", ErrNoPreference, id)
		}
		if err != nil {
			return err
		}
		_, err = s.appendEvent(ctx, tx, at, kindAmend, amendEvent{Session: session, Action: amendUnprefer, ID: id, Reason: reason})
		return err
	})
}

// Preferences returns the preferences in force, oldest first.
func (s *Store) Preferences(ctx context.Context) ([]Preference, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT id, created_at, text FROM policies WHERE retired_at IS NULL ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Preference
	for rows.Next() {
		var p Preference
		var created int64
		if err := rows.Scan(&p.ID, &created, &p.Text); err != nil {
			return nil, err
		}
		p.CreatedAt = time.UnixMilli(created).UTC()
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) applyAmend(ctx context.Context, tx *sql.Tx, at int64, e amendEvent) error {
	switch e.Action {
	case amendPrefer:
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO policies(id, created_at, session_id, text, retired_at) VALUES(?, ?, ?, ?, NULL)`,
			e.ID, at, e.Session, e.Text); err != nil {
			return err
		}
	case amendUnprefer:
		if _, err := tx.ExecContext(ctx,
			`UPDATE policies SET retired_at = ? WHERE id = ? AND retired_at IS NULL`, at, e.ID); err != nil {
			return err
		}
	default:
		if err := s.applyStanding(ctx, tx, e); err != nil {
			return err
		}
	}
	return sessionActive(ctx, tx, e.Session, at)
}

// applyStanding applies an amendment to one memory.
func (s *Store) applyStanding(ctx context.Context, tx *sql.Tx, e amendEvent) error {
	var importance, intensity, strength float64
	var pinned, retracted bool
	err := tx.QueryRowContext(ctx,
		`SELECT importance, intensity, strength, pinned, retracted FROM memories WHERE id = ?`, e.ID).
		Scan(&importance, &intensity, &strength, &pinned, &retracted)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	switch e.Action {
	case AmendRetract:
		retracted = true
	case AmendRestore:
		retracted = false
	case AmendPin:
		pinned = true
	case AmendUnpin:
		pinned = false
	case AmendReweigh:
		// The same rule as at writing: each step of importance is a factor.
		strength = clampStrength(strength * math.Pow(4, 2*(e.Importance-importance)))
		importance = e.Importance
	default:
		return fmt.Errorf("unknown amend action %q", e.Action)
	}
	clock, err := clockOf(ctx, tx)
	if err != nil {
		return err
	}
	core := pinned || s.params.isCore(importance, intensity)
	var fadeAt, archiveAt any
	if !core {
		fadeAt, archiveAt = s.params.crossings(clock, strength)
	}
	_, err = tx.ExecContext(ctx,
		`UPDATE memories SET importance = ?, strength = ?, pinned = ?, retracted = ?, core = ?,
		   touched_ord = ?, fade_at = ?, archive_at = ? WHERE id = ?`,
		importance, strength, pinned, retracted, core, clock, fadeAt, archiveAt, e.ID)
	return err
}

func (s *Store) applyErase(ctx context.Context, tx *sql.Tx, at int64, e eraseEvent) error {
	var n int64
	err := tx.QueryRowContext(ctx, `SELECT n FROM memories WHERE id = ?`, e.ID).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, stmt := range []string{
		`UPDATE memories SET state = '` + StateErased + `', gist = '', body = '', outcome = '', feeling = '',
		   lesson = '', people = '[]', pointer = '', hash = '' WHERE n = ?`,
		`DELETE FROM memories_fts WHERE rowid = ?`,
		`DELETE FROM vectors WHERE n = ?`,
	} {
		if _, err := tx.ExecContext(ctx, stmt, n); err != nil {
			return err
		}
	}
	return sessionActive(ctx, tx, e.Session, at)
}

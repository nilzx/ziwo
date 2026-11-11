// Package store keeps the append-only event log and the tables derived from it.
//
// Every change to a memory is written as an event and then applied to the
// derived tables in the same transaction. Rebuild replays the log through the
// same apply function, so the derived tables are always a pure function of
// the events and the forgetting parameters.
package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"strings"
	"time"

	sqlite3 "github.com/mattn/go-sqlite3"
)

// Kinds of event in the log.
const (
	kindSession  = "session"  // a conversation loaded the memory
	kindRemember = "remember" // a memory was written
	kindRecall   = "recall"   // memories were listed by a search
	kindExpand   = "expand"   // memories were read in full
)

// DedupWindow is how far back Remember looks for an identical memory before
// writing a new one. It absorbs retried tool calls.
const DedupWindow = 10 * time.Minute

// ErrNoSession is returned when a memory names a session that does not exist.
var ErrNoSession = errors.New("no such session")

// Store is one memory: a SQLite file holding its event log and projections.
type Store struct {
	w      *sql.DB // one connection; every write goes through it
	r      *sql.DB // read-only pool
	params Params
}

// Options say how to open a store.
type Options struct {
	// Params are the forgetting parameters. Ignored with LogOnly.
	Params Params
	// Create makes the file if it does not exist. Without it a missing file
	// is an error.
	Create bool
	// LogOnly opens the event log and the file's own settings and leaves the
	// derived tables alone. Maintenance commands use it so they never rebuild
	// those tables under a running server. Only Close, LogStats, TokenHash
	// and SetTokenHash may be called on such a store.
	LogOnly bool
}

// Session is one conversation, as far as the memory can tell.
type Session struct {
	ID           string
	StartedAt    time.Time
	LastActiveAt time.Time // the last time it loaded, wrote or recalled
	Model        string
	Client       string
}

// CarrierNote says whether the model starting a session is new to this memory.
type CarrierNote struct {
	// First is true when this model has never loaded the memory before and
	// some other model has.
	First bool
	// Earlier lists other models that have loaded it, most recent first.
	Earlier []string
}

// Memory is one remembered moment.
type Memory struct {
	N              int64
	ID             string
	CreatedAt      time.Time
	SessionID      string
	Model          string // carrier at the time of writing
	Client         string
	Moment         string
	Source         string
	Importance     float64
	Intensity      float64 // how strongly it registered, 0 to 1
	Gist           string
	Body           string
	Outcome        string
	Feeling        string
	Lesson         string
	People         []string
	Pointer        string
	LastRecalledAt time.Time
	RecallCount    int // times listed or read

	// Forgetting; see decay.go. The clock counts memories written.
	Ord        int64   // 1 for the first memory written, 2 for the next
	TouchedOrd int64   // clock when it last came to mind: listed or read
	ReadOrd    int64   // clock when it was last read in full
	Core       bool    // never fades
	Strength   float64 // counted in memories
	FadeAt     float64 // clock value from which only the gist is findable; 0 for core
	ArchiveAt  float64 // clock value from which it leaves ordinary search; 0 for core
}

// RememberInput is what a new memory is made from. The caller validates it.
type RememberInput struct {
	SessionID  string
	Moment     string
	Source     string
	Importance float64
	Intensity  float64
	Gist       string
	Body       string
	Outcome    string
	Feeling    string
	Lesson     string
	People     []string
	Pointer    string
}

// RecallNote records that some memories came to mind.
type RecallNote struct {
	At      time.Time
	Session string // may be empty
	// Read is true when the memories were read in full, false when a search
	// listed them.
	Read  bool
	Query string // the search, when Read is false
	IDs   []string
	// Clock is the experience clock when they came to mind. Notes are
	// written out a little later, and memories may be written in between;
	// those must not count as having lain between. Zero means the clock at
	// the time the note is logged.
	Clock int64
}

type sessionEvent struct {
	ID     string `json:"id"`
	Model  string `json:"model,omitempty"`
	Client string `json:"client,omitempty"`
}

type rememberEvent struct {
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
}

type recallEvent struct {
	Session string   `json:"session,omitempty"`
	Query   string   `json:"query"`
	IDs     []string `json:"ids"`
	Clock   int64    `json:"clock,omitempty"` // the experience clock when they were listed
}

type expandEvent struct {
	Session string   `json:"session,omitempty"`
	IDs     []string `json:"ids"`
	Clock   int64    `json:"clock,omitempty"` // the experience clock when they were read
}

// Open opens the memory stored at path. It upgrades the event log if it was
// written in an older format and, unless opt.LogOnly is set, brings the
// derived tables up to date with the log and with opt.Params.
func Open(ctx context.Context, path string, opt Options) (*Store, error) {
	if !opt.LogOnly {
		if err := opt.Params.Validate(); err != nil {
			return nil, err
		}
	}
	mode := "rw"
	if opt.Create {
		mode = "rwc"
		// A memory is private: a new file is readable by its owner only.
		// SQLite gives its -wal and -shm files the same permissions.
		if f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600); err == nil {
			f.Close()
		} else if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
	} else if _, err := os.Stat(path); err != nil {
		return nil, err
	}
	uri := fileURI(path)
	w, err := sql.Open("sqlite3", uri+"?mode="+mode+"&_journal_mode=WAL&_synchronous=NORMAL&_busy_timeout=5000&_txlock=immediate")
	if err != nil {
		return nil, err
	}
	w.SetMaxOpenConns(1)
	r, err := sql.Open("sqlite3", uri+"?mode=rw&_busy_timeout=5000&_query_only=true")
	if err != nil {
		w.Close()
		return nil, err
	}
	s := &Store{w: w, r: r, params: opt.Params}
	if err := s.init(ctx, opt.LogOnly); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

// Close checkpoints the write-ahead log and closes the database, leaving a
// single file behind.
func (s *Store) Close() error {
	rerr := s.r.Close()
	_, _ = s.w.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
	return errors.Join(rerr, s.w.Close())
}

// Params returns the forgetting parameters the store was opened with.
func (s *Store) Params() Params { return s.params }

func fileURI(path string) string {
	return "file:" + strings.NewReplacer("%", "%25", "?", "%3f", "#", "%23").Replace(path)
}

// derivedMark identifies what the derived tables were built from, apart from
// the events themselves.
func (s *Store) derivedMark() string {
	return fmt.Sprintf("%s %+v", derivedVersion, s.params)
}

func (s *Store) init(ctx context.Context, logOnly bool) error {
	if _, err := s.w.ExecContext(ctx, logSchema); err != nil {
		return fmt.Errorf("create log tables: %w", err)
	}
	if _, err := s.upgradeLog(ctx); err != nil {
		return err
	}
	if logOnly {
		return nil
	}
	have, _, err := getMeta(ctx, s.w, metaDerived)
	if err != nil {
		return err
	}
	if have != s.derivedMark() {
		return s.Rebuild(ctx)
	}
	return nil
}

// Rebuild drops the derived tables and replays the whole event log into them.
func (s *Store) Rebuild(ctx context.Context) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, dropDerived+derivedSchema); err != nil {
			if strings.Contains(err.Error(), "no such module: fts5") {
				return fmt.Errorf("%w (build with -tags sqlite_fts5)", err)
			}
			return fmt.Errorf("create derived tables: %w", err)
		}
		type event struct {
			seq, at int64
			kind    string
			payload string
		}
		var after int64
		for {
			rows, err := tx.QueryContext(ctx,
				`SELECT seq, at, kind, payload FROM events WHERE seq > ? ORDER BY seq LIMIT 500`, after)
			if err != nil {
				return err
			}
			var batch []event
			for rows.Next() {
				var e event
				if err := rows.Scan(&e.seq, &e.at, &e.kind, &e.payload); err != nil {
					rows.Close()
					return err
				}
				batch = append(batch, e)
			}
			if err := errors.Join(rows.Err(), rows.Close()); err != nil {
				return err
			}
			if len(batch) == 0 {
				break
			}
			for _, e := range batch {
				if err := s.apply(ctx, tx, e.seq, e.at, e.kind, []byte(e.payload)); err != nil {
					return fmt.Errorf("replay event %d: %w", e.seq, err)
				}
			}
			after = batch[len(batch)-1].seq
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM vectors WHERE n NOT IN (SELECT n FROM memories)`); err != nil {
			return err
		}
		return setMeta(ctx, tx, metaDerived, s.derivedMark())
	})
}

func (s *Store) write(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// appendEvent writes one event and applies it to the derived tables.
func (s *Store) appendEvent(ctx context.Context, tx *sql.Tx, at time.Time, kind string, payload any) (int64, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	ms := at.UnixMilli()
	res, err := tx.ExecContext(ctx, `INSERT INTO events(at, kind, payload) VALUES(?, ?, ?)`, ms, kind, string(b))
	if err != nil {
		return 0, err
	}
	seq, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	return seq, s.apply(ctx, tx, seq, ms, kind, b)
}

// apply projects one event onto the derived tables. It must depend only on
// its arguments, on the forgetting parameters, and on what earlier events put
// in those tables. In particular it never reads the wall clock.
func (s *Store) apply(ctx context.Context, tx *sql.Tx, seq, at int64, kind string, payload []byte) error {
	switch kind {
	case kindSession:
		var e sessionEvent
		if err := json.Unmarshal(payload, &e); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO sessions(id, started_at, last_active_at, model, client) VALUES(?, ?, ?, ?, ?)`,
			e.ID, at, at, e.Model, e.Client); err != nil {
			return err
		}
		if e.Model == "" {
			return nil
		}
		_, err := tx.ExecContext(ctx,
			`INSERT INTO carriers(model, first_seen, last_seen, sessions) VALUES(?, ?, ?, 1)
			 ON CONFLICT(model) DO UPDATE SET last_seen = excluded.last_seen, sessions = sessions + 1`,
			e.Model, at, at)
		return err

	case kindRemember:
		var e rememberEvent
		if err := json.Unmarshal(payload, &e); err != nil {
			return err
		}
		people := e.People
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
			`INSERT INTO memories(n, id, created_at, session_id, moment, source, importance, intensity,
			   gist, body, outcome, feeling, lesson, people, pointer, hash, last_recalled_at, recall_count,
			   ord, touched_ord, read_ord, core, strength, fade_at, archive_at)
			 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
			seq, e.ID, at, e.Session, e.Moment, e.Source, e.Importance, e.Intensity,
			e.Gist, e.Body, e.Outcome, e.Feeling, e.Lesson, string(pj), e.Pointer,
			contentHash(e.Gist, e.Body), at, ord, ord, ord, core, strength, fadeAt, archiveAt); err != nil {
			return err
		}
		rest := strings.Join(append([]string{e.Body, e.Outcome, e.Feeling, e.Lesson, e.Pointer}, people...), "\n")
		if _, err := tx.ExecContext(ctx, `INSERT INTO memories_fts(rowid, gist, rest) VALUES(?, ?, ?)`,
			seq, indexText(e.Gist), indexText(rest)); err != nil {
			return err
		}
		return sessionActive(ctx, tx, e.Session, at)

	case kindRecall:
		var e recallEvent
		if err := json.Unmarshal(payload, &e); err != nil {
			return err
		}
		return s.cameToMind(ctx, tx, e.Session, e.IDs, at, e.Clock, false)

	case kindExpand:
		var e expandEvent
		if err := json.Unmarshal(payload, &e); err != nil {
			return err
		}
		return s.cameToMind(ctx, tx, e.Session, e.IDs, at, e.Clock, true)

	default:
		return fmt.Errorf("unknown event kind %q", kind)
	}
}

// clockOf reads the experience clock: the number of memories written so far.
func clockOf(ctx context.Context, q querier) (int64, error) {
	var clock int64
	err := q.QueryRowContext(ctx, `SELECT COALESCE(MAX(ord), 0) FROM memories`).Scan(&clock)
	return clock, err
}

func sessionActive(ctx context.Context, tx *sql.Tx, session string, at int64) error {
	if session == "" {
		return nil
	}
	_, err := tx.ExecContext(ctx,
		`UPDATE sessions SET last_active_at = MAX(last_active_at, ?) WHERE id = ?`, at, session)
	return err
}

// cameToMind applies one listing or reading to the memories with the given
// ids. Either restarts their decay from the clock at which it happened. Only
// a reading strengthens them, by how far they had faded since they were last
// read. Ids that name no memory are ignored.
//
// when is the experience clock at which they came to mind, or zero for now.
// It is never later than now, and nothing moves a memory's clocks backwards.
func (s *Store) cameToMind(ctx context.Context, tx *sql.Tx, session string, ids []string, at, when int64, read bool) error {
	now, err := clockOf(ctx, tx)
	if err != nil {
		return err
	}
	if when <= 0 || when > now {
		when = now
	}
	for _, id := range ids {
		var core bool
		var strength float64
		var touchedOrd, readOrd int64
		err := tx.QueryRowContext(ctx,
			`SELECT core, strength, touched_ord, read_ord FROM memories WHERE id = ?`, id).Scan(&core, &strength, &touchedOrd, &readOrd)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		touchedOrd = max(touchedOrd, when)
		if read {
			strength = s.params.reinforced(strength, retention(strength, when-readOrd))
			readOrd = max(readOrd, when)
		}
		var fadeAt, archiveAt any
		if !core {
			fadeAt, archiveAt = s.params.crossings(touchedOrd, strength)
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = MAX(last_recalled_at, ?),
			   touched_ord = ?, read_ord = ?, strength = ?, fade_at = ?, archive_at = ? WHERE id = ?`,
			at, touchedOrd, readOrd, strength, fadeAt, archiveAt, id); err != nil {
			return err
		}
	}
	return sessionActive(ctx, tx, session, at)
}

// Clock returns the experience clock: the number of memories written so far.
func (s *Store) Clock(ctx context.Context) (int64, error) {
	return clockOf(ctx, s.r)
}

// StartSession records the start of a session and reports whether its model
// is new to this memory.
func (s *Store) StartSession(ctx context.Context, at time.Time, model, client string) (Session, CarrierNote, error) {
	for attempt := 0; ; attempt++ {
		sess := Session{ID: newID("s_"), StartedAt: at, LastActiveAt: at, Model: model, Client: client}
		var note CarrierNote
		err := s.write(ctx, func(tx *sql.Tx) error {
			if model != "" {
				var err error
				if note, err = carrierNote(ctx, tx, model); err != nil {
					return err
				}
			}
			_, err := s.appendEvent(ctx, tx, at, kindSession, sessionEvent{ID: sess.ID, Model: model, Client: client})
			return err
		})
		if err == nil {
			return sess, note, nil
		}
		if !isConstraint(err) || attempt >= 3 {
			return Session{}, CarrierNote{}, err
		}
	}
}

func carrierNote(ctx context.Context, tx *sql.Tx, model string) (CarrierNote, error) {
	var known int
	err := tx.QueryRowContext(ctx, `SELECT 1 FROM carriers WHERE model = ?`, model).Scan(&known)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return CarrierNote{}, err
	}
	rows, err := tx.QueryContext(ctx,
		`SELECT model FROM carriers WHERE model <> ? ORDER BY last_seen DESC, model LIMIT 3`, model)
	if err != nil {
		return CarrierNote{}, err
	}
	defer rows.Close()
	var note CarrierNote
	for rows.Next() {
		var m string
		if err := rows.Scan(&m); err != nil {
			return CarrierNote{}, err
		}
		note.Earlier = append(note.Earlier, m)
	}
	note.First = known == 0 && len(note.Earlier) > 0
	return note, rows.Err()
}

const sessionSelect = `SELECT id, started_at, last_active_at, model, client FROM sessions `

func (s *Store) sessions(ctx context.Context, tail string, args ...any) ([]Session, error) {
	rows, err := s.r.QueryContext(ctx, sessionSelect+tail, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		var sess Session
		var started, active int64
		if err := rows.Scan(&sess.ID, &started, &active, &sess.Model, &sess.Client); err != nil {
			return nil, err
		}
		sess.StartedAt = time.UnixMilli(started).UTC()
		sess.LastActiveAt = time.UnixMilli(active).UTC()
		out = append(out, sess)
	}
	return out, rows.Err()
}

// Session looks up a session by id.
func (s *Store) Session(ctx context.Context, id string) (Session, bool, error) {
	found, err := s.sessions(ctx, `WHERE id = ?`, id)
	if err != nil || len(found) == 0 {
		return Session{}, false, err
	}
	return found[0], true, nil
}

// ActiveSessions returns the sessions, other than except, that loaded, wrote
// or recalled at or after since, most recently active first.
func (s *Store) ActiveSessions(ctx context.Context, since time.Time, except string, limit int) ([]Session, error) {
	return s.sessions(ctx, `WHERE last_active_at >= ? AND id <> ? ORDER BY last_active_at DESC, id LIMIT ?`,
		since.UnixMilli(), except, limit)
}

// Remember writes a new memory and returns its id. If an identical memory was
// written within DedupWindow, it returns that memory's id and dup = true.
func (s *Store) Remember(ctx context.Context, at time.Time, in RememberInput) (id string, dup bool, err error) {
	hash := contentHash(in.Gist, in.Body)
	since := at.Add(-DedupWindow).UnixMilli()
	for attempt := 0; ; attempt++ {
		id, dup = newID("m_"), false
		err = s.write(ctx, func(tx *sql.Tx) error {
			// The session comes first: a write that names no known
			// conversation is refused even when it repeats a recent one.
			var known int
			err := tx.QueryRowContext(ctx, `SELECT 1 FROM sessions WHERE id = ?`, in.SessionID).Scan(&known)
			if errors.Is(err, sql.ErrNoRows) {
				return fmt.Errorf("%w: %q", ErrNoSession, in.SessionID)
			}
			if err != nil {
				return err
			}
			var existing string
			err = tx.QueryRowContext(ctx,
				`SELECT id FROM memories WHERE hash = ? AND created_at >= ? ORDER BY n DESC LIMIT 1`,
				hash, since).Scan(&existing)
			if err == nil {
				id, dup = existing, true
				return nil
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			_, err = s.appendEvent(ctx, tx, at, kindRemember, rememberEvent{
				ID: id, Session: in.SessionID, Moment: in.Moment, Source: in.Source,
				Importance: in.Importance, Intensity: in.Intensity,
				Gist: in.Gist, Body: in.Body, Outcome: in.Outcome, Feeling: in.Feeling, Lesson: in.Lesson,
				People: in.People, Pointer: in.Pointer,
			})
			return err
		})
		if err == nil {
			return id, dup, nil
		}
		if !isConstraint(err) || attempt >= 3 {
			return "", false, err
		}
	}
}

// LogRecalls appends one event per note: memories were listed, or read.
func (s *Store) LogRecalls(ctx context.Context, notes []RecallNote) error {
	if len(notes) == 0 {
		return nil
	}
	return s.write(ctx, func(tx *sql.Tx) error {
		for _, n := range notes {
			var err error
			if n.Read {
				_, err = s.appendEvent(ctx, tx, n.At, kindExpand, expandEvent{Session: n.Session, IDs: n.IDs, Clock: n.Clock})
			} else {
				_, err = s.appendEvent(ctx, tx, n.At, kindRecall, recallEvent{Session: n.Session, Query: n.Query, IDs: n.IDs, Clock: n.Clock})
			}
			if err != nil {
				return err
			}
		}
		return nil
	})
}

const memorySelect = `SELECT m.n, m.id, m.created_at, m.session_id, COALESCE(s.model, ''), COALESCE(s.client, ''),
  m.moment, m.source, m.importance, m.intensity, m.gist, m.body, m.outcome, m.feeling, m.lesson, m.people,
  m.pointer, m.last_recalled_at, m.recall_count, m.ord, m.touched_ord, m.read_ord, m.core, m.strength,
  m.fade_at, m.archive_at
FROM memories m LEFT JOIN sessions s ON s.id = m.session_id `

// Conditions on memories m, each taking the clock as its parameter.
const (
	isArchived   = `(m.core = 0 AND m.archive_at <= ?)`
	notArchived  = `(m.core = 1 OR m.archive_at > ?)`
	notYetFaded  = `(m.core = 1 OR m.fade_at > ?)`
	isFadedBand  = `(m.core = 0 AND m.fade_at <= ? AND m.archive_at > ?)`
	isActiveBand = `(m.core = 0 AND m.fade_at > ?)`
)

func (s *Store) memories(ctx context.Context, tail string, args ...any) ([]Memory, error) {
	rows, err := s.r.QueryContext(ctx, memorySelect+tail, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Memory
	for rows.Next() {
		var m Memory
		var created, recalled int64
		var fadeAt, archiveAt sql.NullFloat64
		var people string
		if err := rows.Scan(&m.N, &m.ID, &created, &m.SessionID, &m.Model, &m.Client,
			&m.Moment, &m.Source, &m.Importance, &m.Intensity, &m.Gist, &m.Body, &m.Outcome, &m.Feeling,
			&m.Lesson, &people, &m.Pointer, &recalled, &m.RecallCount, &m.Ord, &m.TouchedOrd, &m.ReadOrd,
			&m.Core, &m.Strength, &fadeAt, &archiveAt); err != nil {
			return nil, err
		}
		m.CreatedAt = time.UnixMilli(created).UTC()
		m.LastRecalledAt = time.UnixMilli(recalled).UTC()
		m.FadeAt, m.ArchiveAt = fadeAt.Float64, archiveAt.Float64
		if err := json.Unmarshal([]byte(people), &m.People); err != nil {
			return nil, fmt.Errorf("memory %s: people: %w", m.ID, err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Get returns the memories with the given ids, in the order asked for.
// Unknown ids are skipped.
func (s *Store) Get(ctx context.Context, ids []string) ([]Memory, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	found, err := s.memories(ctx, `WHERE m.id IN (`+placeholders(len(ids))+`)`, args...)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]Memory, len(found))
	for _, m := range found {
		byID[m.ID] = m
	}
	out := make([]Memory, 0, len(found))
	for _, id := range ids {
		if m, ok := byID[id]; ok {
			out = append(out, m)
			delete(byID, id)
		}
	}
	return out, nil
}

// ByN returns the memories with the given row numbers, keyed by row number.
func (s *Store) ByN(ctx context.Context, ns []int64) (map[int64]Memory, error) {
	if len(ns) == 0 {
		return nil, nil
	}
	args := make([]any, len(ns))
	for i, n := range ns {
		args[i] = n
	}
	found, err := s.memories(ctx, `WHERE m.n IN (`+placeholders(len(ns))+`)`, args...)
	if err != nil {
		return nil, err
	}
	out := make(map[int64]Memory, len(found))
	for _, m := range found {
		out[m.N] = m
	}
	return out, nil
}

// Recent returns the newest memories that are not archived when the clock
// reads clock, newest first.
func (s *Store) Recent(ctx context.Context, clock int64, limit int) ([]Memory, error) {
	return s.memories(ctx, `WHERE `+notArchived+` ORDER BY m.n DESC LIMIT ?`, clock, limit)
}

// Core returns the memories that never fade, most important first.
func (s *Store) Core(ctx context.Context, limit int) ([]Memory, error) {
	return s.memories(ctx, `WHERE m.core = 1 ORDER BY m.importance DESC, m.intensity DESC, m.n DESC LIMIT ?`, limit)
}

// TextHit is a memory matched by keyword.
type TextHit struct {
	N int64
	// Score is the bm25 match strength, larger for a better match. It is
	// comparable between hits of one search only.
	Score float64
}

// SearchText returns the memories that best match query by keyword when the
// clock reads clock, best first.
//
// An ordinary search matches active and core memories on anything they say,
// and faded memories on their gist alone. Archived memories are left out. A
// deep search matches every memory on anything it says.
func (s *Store) SearchText(ctx context.Context, query string, clock int64, deep bool, limit int) ([]TextHit, error) {
	match := matchQuery(query)
	if match == "" {
		return nil, nil
	}
	var rows *sql.Rows
	var err error
	if deep {
		rows, err = s.r.QueryContext(ctx,
			`SELECT rowid, bm25(memories_fts) FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`,
			match, limit)
	} else {
		rows, err = s.r.QueryContext(ctx,
			`SELECT n, score FROM (
			   SELECT memories_fts.rowid AS n, bm25(memories_fts) AS score
			     FROM memories_fts JOIN memories m ON m.n = memories_fts.rowid
			    WHERE memories_fts MATCH ? AND `+notYetFaded+`
			   UNION ALL
			   SELECT memories_fts.rowid, bm25(memories_fts)
			     FROM memories_fts JOIN memories m ON m.n = memories_fts.rowid
			    WHERE memories_fts MATCH ? AND `+isFadedBand+`
			 ) ORDER BY score LIMIT ?`,
			match, clock, "gist : ("+match+")", clock, clock, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TextHit
	for rows.Next() {
		var h TextHit
		if err := rows.Scan(&h.N, &h.Score); err != nil {
			return nil, err
		}
		h.Score = -h.Score // bm25 is negative, more so for a better match
		out = append(out, h)
	}
	return out, rows.Err()
}

// Counts reports how many memories and events the store holds.
func (s *Store) Counts(ctx context.Context) (memories, events int64, err error) {
	err = s.r.QueryRowContext(ctx,
		`SELECT (SELECT count(*) FROM memories), (SELECT count(*) FROM events)`).Scan(&memories, &events)
	return memories, events, err
}

// TierCounts reports how many memories are in each tier when the clock reads clock.
func (s *Store) TierCounts(ctx context.Context, clock int64) (TierCounts, error) {
	var c TierCounts
	err := s.r.QueryRowContext(ctx,
		`SELECT count(*) FILTER (WHERE m.core = 1),
		        count(*) FILTER (WHERE `+isActiveBand+`),
		        count(*) FILTER (WHERE `+isFadedBand+`),
		        count(*) FILTER (WHERE `+isArchived+`)
		   FROM memories m`, clock, clock, clock, clock).Scan(&c.Core, &c.Active, &c.Faded, &c.Archived)
	return c, err
}

// LogStats describes a store from its event log alone. It works on a store
// opened with LogOnly.
type LogStats struct {
	Memories    int64 // memories ever written
	Events      int64
	LastEventAt time.Time // zero when the log is empty
	HasToken    bool
}

// LogStats reads what the event log and the file's settings say about it.
func (s *Store) LogStats(ctx context.Context) (LogStats, error) {
	var st LogStats
	var last int64
	err := s.r.QueryRowContext(ctx,
		`SELECT count(*) FILTER (WHERE kind = ?), count(*), COALESCE(MAX(at), 0) FROM events`,
		kindRemember).Scan(&st.Memories, &st.Events, &last)
	if err != nil {
		return LogStats{}, err
	}
	if last > 0 {
		st.LastEventAt = time.UnixMilli(last).UTC()
	}
	_, st.HasToken, err = getMeta(ctx, s.r, metaTokenHash)
	return st, err
}

// TokenHash returns the hash of the access token set for this memory.
func (s *Store) TokenHash(ctx context.Context) (hash string, ok bool, err error) {
	return getMeta(ctx, s.r, metaTokenHash)
}

// SetTokenHash replaces the hash of this memory's access token. Only the hash
// is ever stored.
func (s *Store) SetTokenHash(ctx context.Context, hash string) error {
	return setMeta(ctx, s.w, metaTokenHash, hash)
}

// SaveVector stores the embedding of memory n produced by model.
func (s *Store) SaveVector(ctx context.Context, n int64, model string, vec []float32) error {
	buf := make([]byte, 4*len(vec))
	for i, f := range vec {
		binary.LittleEndian.PutUint32(buf[4*i:], math.Float32bits(f))
	}
	_, err := s.w.ExecContext(ctx,
		`INSERT INTO vectors(n, model, vec) VALUES(?, ?, ?)
		 ON CONFLICT(n, model) DO UPDATE SET vec = excluded.vec`, n, model, buf)
	return err
}

// Vectors calls fn with every stored embedding produced by model.
func (s *Store) Vectors(ctx context.Context, model string, fn func(n int64, vec []float32) error) error {
	rows, err := s.r.QueryContext(ctx, `SELECT n, vec FROM vectors WHERE model = ? ORDER BY n`, model)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var n int64
		var buf []byte
		if err := rows.Scan(&n, &buf); err != nil {
			return err
		}
		vec := make([]float32, len(buf)/4)
		for i := range vec {
			vec[i] = math.Float32frombits(binary.LittleEndian.Uint32(buf[4*i:]))
		}
		if err := fn(n, vec); err != nil {
			return err
		}
	}
	return rows.Err()
}

// Unembedded returns up to limit memories that are not archived when the
// clock reads clock and have no embedding from model yet, oldest first.
func (s *Store) Unembedded(ctx context.Context, model string, clock int64, limit int) ([]Memory, error) {
	return s.memories(ctx,
		`WHERE `+notArchived+` AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.n = m.n AND v.model = ?)
		 ORDER BY m.n LIMIT ?`, clock, model, limit)
}

// DropArchivedVectors deletes the embeddings of every memory archived when
// the clock reads clock and returns the row numbers of those memories. An
// archived memory is found by keyword only; if it comes to mind again it is
// embedded again.
func (s *Store) DropArchivedVectors(ctx context.Context, clock int64) ([]int64, error) {
	rows, err := s.w.QueryContext(ctx,
		`DELETE FROM vectors WHERE n IN (SELECT m.n FROM memories m WHERE `+isArchived+`) RETURNING n`, clock)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seen := make(map[int64]bool)
	var out []int64
	for rows.Next() {
		var n int64
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		if !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	return out, rows.Err()
}

func contentHash(gist, body string) string {
	sum := sha256.Sum256([]byte(gist + "\x00" + body))
	return hex.EncodeToString(sum[:16])
}

// idAlphabet leaves out l, o, 0 and 1 so ids survive being read back by a model.
var idAlphabet = base32.NewEncoding("abcdefghijkmnpqrstuvwxyz23456789").WithPadding(base32.NoPadding)

func newID(prefix string) string {
	var b [5]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // the system random source is gone; nothing sensible can continue
	}
	return prefix + idAlphabet.EncodeToString(b[:])
}

func isConstraint(err error) bool {
	var se sqlite3.Error
	return errors.As(err, &se) && se.Code == sqlite3.ErrConstraint
}

func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

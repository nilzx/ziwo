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
	"strings"
	"time"

	sqlite3 "github.com/mattn/go-sqlite3"
)

const (
	kindSession  = "session"
	kindRemember = "remember"
	kindRecall   = "recall"
)

// DedupWindow is how far back Remember looks for an identical memory before
// writing a new one. It absorbs retried tool calls.
const DedupWindow = 10 * time.Minute

// ErrNoSession is returned when a memory names a session that does not exist.
var ErrNoSession = errors.New("no such session")

// Store is a SQLite database holding the event log and its projections.
type Store struct {
	w      *sql.DB // one connection; every write goes through it
	r      *sql.DB // read-only pool
	params Params
}

// Session is one conversation, as far as the memory can tell.
type Session struct {
	ID        string
	StartedAt time.Time
	Model     string
	Client    string
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
	RecallCount    int

	Core      bool      // never fades
	Strength  float64   // days; see decay.go
	FadeAt    time.Time // zero for a core memory
	ArchiveAt time.Time // zero for a core memory
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

// RecallNote records that some memories came back to mind: a search surfaced
// them, or they were read in full.
type RecallNote struct {
	At      time.Time
	Session string
	Query   string // empty when the memories were read by id
	IDs     []string
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
	Query   string   `json:"query,omitempty"`
	IDs     []string `json:"ids"`
}

// Open opens the database at path, creating it if needed, and brings the
// derived tables up to date with the event log and with params.
func Open(ctx context.Context, path string, params Params) (*Store, error) {
	if err := params.validate(); err != nil {
		return nil, err
	}
	uri := fileURI(path)
	w, err := sql.Open("sqlite3", uri+"?_journal_mode=WAL&_synchronous=NORMAL&_busy_timeout=5000&_txlock=immediate")
	if err != nil {
		return nil, err
	}
	w.SetMaxOpenConns(1)
	r, err := sql.Open("sqlite3", uri+"?_busy_timeout=5000&_query_only=true")
	if err != nil {
		w.Close()
		return nil, err
	}
	s := &Store{w: w, r: r, params: params}
	if err := s.init(ctx); err != nil {
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

func (s *Store) init(ctx context.Context) error {
	if _, err := s.w.ExecContext(ctx, logSchema); err != nil {
		return fmt.Errorf("create log tables: %w", err)
	}
	var have string
	err := s.w.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = 'derived'`).Scan(&have)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && have != s.derivedMark()) {
		return s.Rebuild(ctx)
	}
	return err
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
		_, err := tx.ExecContext(ctx,
			`INSERT INTO meta(key, value) VALUES('derived', ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, s.derivedMark())
		return err
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
// in those tables. In particular it never reads the clock.
func (s *Store) apply(ctx context.Context, tx *sql.Tx, seq, at int64, kind string, payload []byte) error {
	switch kind {
	case kindSession:
		var e sessionEvent
		if err := json.Unmarshal(payload, &e); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO sessions(id, started_at, model, client) VALUES(?, ?, ?, ?)`,
			e.ID, at, e.Model, e.Client); err != nil {
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
		core := s.params.isCore(e.Importance, e.Intensity)
		strength := s.params.initialStrength(e.Importance, e.Intensity, e.Source)
		var fadeAt, archiveAt any // NULL for a core memory
		if !core {
			fadeAt, archiveAt = s.params.crossings(at, strength)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO memories(n, id, created_at, session_id, moment, source, importance, intensity,
			   gist, body, outcome, feeling, lesson, people, pointer, hash, last_recalled_at, recall_count,
			   core, strength, fade_at, archive_at)
			 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
			seq, e.ID, at, e.Session, e.Moment, e.Source, e.Importance, e.Intensity,
			e.Gist, e.Body, e.Outcome, e.Feeling, e.Lesson, string(pj), e.Pointer,
			contentHash(e.Gist, e.Body), at, core, strength, fadeAt, archiveAt); err != nil {
			return err
		}
		rest := strings.Join(append([]string{e.Body, e.Outcome, e.Feeling, e.Lesson, e.Pointer}, people...), "\n")
		_, err = tx.ExecContext(ctx, `INSERT INTO memories_fts(rowid, gist, rest) VALUES(?, ?, ?)`,
			seq, indexText(e.Gist), indexText(rest))
		return err

	case kindRecall:
		var e recallEvent
		if err := json.Unmarshal(payload, &e); err != nil {
			return err
		}
		for _, id := range e.IDs {
			if err := s.reinforce(ctx, tx, id, at); err != nil {
				return err
			}
		}
		return nil

	default:
		return fmt.Errorf("unknown event kind %q (was the log written by a newer version?)", kind)
	}
}

// reinforce applies one recall at time at to the memory with the given id:
// it strengthens the memory by how far it had faded and restarts its decay.
// An id that names no memory is ignored.
func (s *Store) reinforce(ctx context.Context, tx *sql.Tx, id string, at int64) error {
	var core bool
	var strength float64
	var last int64
	err := tx.QueryRowContext(ctx,
		`SELECT core, strength, last_recalled_at FROM memories WHERE id = ?`, id).Scan(&core, &strength, &last)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if at > last {
		strength = s.params.reinforced(strength, retention(strength, at-last))
		last = at
	}
	var fadeAt, archiveAt any
	if !core {
		fadeAt, archiveAt = s.params.crossings(last, strength)
	}
	_, err = tx.ExecContext(ctx,
		`UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = ?, strength = ?,
		   fade_at = ?, archive_at = ? WHERE id = ?`, last, strength, fadeAt, archiveAt, id)
	return err
}

// StartSession records the start of a session and reports whether its model
// is new to this memory.
func (s *Store) StartSession(ctx context.Context, at time.Time, model, client string) (Session, CarrierNote, error) {
	for attempt := 0; ; attempt++ {
		sess := Session{ID: newID("s_"), StartedAt: at, Model: model, Client: client}
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

// Session looks up a session by id.
func (s *Store) Session(ctx context.Context, id string) (Session, bool, error) {
	return s.session(ctx, `WHERE id = ?`, id)
}

// LatestSession returns the most recent session started by client at or after since.
func (s *Store) LatestSession(ctx context.Context, client string, since time.Time) (Session, bool, error) {
	return s.session(ctx, `WHERE client = ? AND started_at >= ? ORDER BY started_at DESC, id LIMIT 1`,
		client, since.UnixMilli())
}

func (s *Store) session(ctx context.Context, where string, args ...any) (Session, bool, error) {
	var sess Session
	var at int64
	err := s.r.QueryRowContext(ctx, `SELECT id, started_at, model, client FROM sessions `+where, args...).
		Scan(&sess.ID, &at, &sess.Model, &sess.Client)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, false, nil
	}
	if err != nil {
		return Session{}, false, err
	}
	sess.StartedAt = time.UnixMilli(at).UTC()
	return sess, true, nil
}

// Remember writes a new memory and returns its id. If an identical memory was
// written within DedupWindow, it returns that memory's id and dup = true.
func (s *Store) Remember(ctx context.Context, at time.Time, in RememberInput) (id string, dup bool, err error) {
	hash := contentHash(in.Gist, in.Body)
	since := at.Add(-DedupWindow).UnixMilli()
	for attempt := 0; ; attempt++ {
		id, dup = newID("m_"), false
		err = s.write(ctx, func(tx *sql.Tx) error {
			var existing string
			err := tx.QueryRowContext(ctx,
				`SELECT id FROM memories WHERE hash = ? AND created_at >= ? ORDER BY n DESC LIMIT 1`,
				hash, since).Scan(&existing)
			if err == nil {
				id, dup = existing, true
				return nil
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			var ok int
			err = tx.QueryRowContext(ctx, `SELECT 1 FROM sessions WHERE id = ?`, in.SessionID).Scan(&ok)
			if errors.Is(err, sql.ErrNoRows) {
				return fmt.Errorf("%w: %q", ErrNoSession, in.SessionID)
			}
			if err != nil {
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

// LogRecalls appends one recall event per note. Each one strengthens the
// memories it names and brings faded ones back.
func (s *Store) LogRecalls(ctx context.Context, notes []RecallNote) error {
	if len(notes) == 0 {
		return nil
	}
	return s.write(ctx, func(tx *sql.Tx) error {
		for _, n := range notes {
			if _, err := s.appendEvent(ctx, tx, n.At, kindRecall,
				recallEvent{Session: n.Session, Query: n.Query, IDs: n.IDs}); err != nil {
				return err
			}
		}
		return nil
	})
}

const memorySelect = `SELECT m.n, m.id, m.created_at, m.session_id, COALESCE(s.model, ''), COALESCE(s.client, ''),
  m.moment, m.source, m.importance, m.intensity, m.gist, m.body, m.outcome, m.feeling, m.lesson, m.people,
  m.pointer, m.last_recalled_at, m.recall_count, m.core, m.strength, m.fade_at, m.archive_at
FROM memories m LEFT JOIN sessions s ON s.id = m.session_id `

// Conditions on memories m, each taking the current time in milliseconds.
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
		var fadeAt, archiveAt sql.NullInt64
		var people string
		if err := rows.Scan(&m.N, &m.ID, &created, &m.SessionID, &m.Model, &m.Client,
			&m.Moment, &m.Source, &m.Importance, &m.Intensity, &m.Gist, &m.Body, &m.Outcome, &m.Feeling,
			&m.Lesson, &people, &m.Pointer, &recalled, &m.RecallCount,
			&m.Core, &m.Strength, &fadeAt, &archiveAt); err != nil {
			return nil, err
		}
		m.CreatedAt = time.UnixMilli(created).UTC()
		m.LastRecalledAt = time.UnixMilli(recalled).UTC()
		if fadeAt.Valid {
			m.FadeAt = time.UnixMilli(fadeAt.Int64).UTC()
		}
		if archiveAt.Valid {
			m.ArchiveAt = time.UnixMilli(archiveAt.Int64).UTC()
		}
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

// Recent returns the newest memories that are not archived at now, newest first.
func (s *Store) Recent(ctx context.Context, now time.Time, limit int) ([]Memory, error) {
	return s.memories(ctx, `WHERE `+notArchived+` ORDER BY m.n DESC LIMIT ?`, now.UnixMilli(), limit)
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

// SearchText returns the memories that best match query by keyword at now,
// best first.
//
// An ordinary search matches active and core memories on anything they say,
// and faded memories on their gist alone. Archived memories are left out. A
// deep search matches every memory on anything it says.
func (s *Store) SearchText(ctx context.Context, query string, now time.Time, deep bool, limit int) ([]TextHit, error) {
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
		ms := now.UnixMilli()
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
			match, ms, "gist : ("+match+")", ms, ms, limit)
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

// TierCounts reports how many memories are in each tier at now.
func (s *Store) TierCounts(ctx context.Context, now time.Time) (TierCounts, error) {
	ms := now.UnixMilli()
	var c TierCounts
	err := s.r.QueryRowContext(ctx,
		`SELECT count(*) FILTER (WHERE m.core = 1),
		        count(*) FILTER (WHERE `+isActiveBand+`),
		        count(*) FILTER (WHERE `+isFadedBand+`),
		        count(*) FILTER (WHERE `+isArchived+`)
		   FROM memories m`, ms, ms, ms, ms).Scan(&c.Core, &c.Active, &c.Faded, &c.Archived)
	return c, err
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

// Unembedded returns up to limit memories that are not archived at now and
// have no embedding from model yet, oldest first.
func (s *Store) Unembedded(ctx context.Context, model string, now time.Time, limit int) ([]Memory, error) {
	return s.memories(ctx,
		`WHERE `+notArchived+` AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.n = m.n AND v.model = ?)
		 ORDER BY m.n LIMIT ?`, now.UnixMilli(), model, limit)
}

// DropArchivedVectors deletes the embeddings of every memory archived at now
// and returns the row numbers of those memories. An archived memory is found
// by keyword only; if it is recalled again it is embedded again.
func (s *Store) DropArchivedVectors(ctx context.Context, now time.Time) ([]int64, error) {
	rows, err := s.w.QueryContext(ctx,
		`DELETE FROM vectors WHERE n IN (SELECT m.n FROM memories m WHERE `+isArchived+`) RETURNING n`,
		now.UnixMilli())
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

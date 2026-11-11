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
	KindFragment   = "fragment"   // a moment, written as it happened; waits to be reflected on
	KindEpisode    = "episode"    // an account put together from fragments
	KindLesson     = "lesson"     // something to carry forward, drawn from experience
	KindImpression = "impression" // how a person or a thing has come across
	KindSelf       = "self"       // a statement about oneself, grown from experience
	KindReading    = "reading"    // a later understanding of an earlier memory
)

// SourceReconstructed marks a memory written afterwards from a record of what
// happened, such as an old transcript, rather than at the moment.
const SourceReconstructed = "reconstructed"

// Standing of a memory that is no longer live.
const (
	StateSuperseded = "superseded" // a correction or a newer version replaced it
	StateAbsorbed   = "absorbed"   // an episode was put together from it
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
	About   string   `json:"about,omitempty"`   // impression: who or what it is about
	Context string   `json:"context,omitempty"` // self: the situation the statement holds in
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
	if e.Kind == KindFragment {
		e.Kind = ""
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO contents(id, data) VALUES(?, ?)`, e.ID, data); err != nil {
		return err
	}
	_, err := s.appendEvent(ctx, tx, at, kindRemember, e)
	return err
}

// ticks reports whether writing this memory advances the experience clock.
// Only a moment written as it happens does. An account put together later, a
// correction, and what is reconstructed from a record add nothing new to what
// was lived through, so they must not push other memories further away.
func (e rememberEvent) ticks() bool {
	return e.Kind == "" && e.Corrects == "" && e.Source != SourceReconstructed
}

// kindFactor scales the starting strength of a memory by its kind: an account
// outlasts the moments it was made from, an impression outlasts that, and a
// lesson lasts longest.
func kindFactor(kind string) float64 {
	switch kind {
	case KindEpisode:
		return 2
	case KindImpression:
		return 3
	case KindLesson:
		return 4
	}
	return 1
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
	ord := clock
	if e.ticks() {
		ord = clock + 1
	}
	core := s.params.isCore(e.Importance, e.Intensity) || kind == KindSelf || e.Milestone
	strength := clampStrength(s.params.initialStrength(e.Importance, e.Intensity, e.Source) * kindFactor(kind))
	var fadeAt, archiveAt any // NULL for a core memory
	if !core {
		fadeAt, archiveAt = s.params.crossings(ord, strength)
	}
	happened := at
	if e.Happened > 0 {
		happened = e.Happened
	}
	var reviewed any // a fragment waits for reflect; everything else needs none
	if kind != KindFragment {
		reviewed = ord
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO memories(n, id, created_at, written_at, session_id, kind, moment, source, importance, intensity,
		   gist, body, outcome, feeling, lesson, people, pointer, about, context, ref, milestone,
		   hash, last_recalled_at, recall_count, ord, touched_ord, read_ord, core, strength, fade_at, archive_at,
		   reviewed, state, state_by, retracted, pinned, corrects)
		 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, 0, ?)`,
		seq, e.ID, happened, at, e.Session, kind, e.Moment, e.Source, e.Importance, e.Intensity,
		c.Gist, c.Body, c.Outcome, c.Feeling, c.Lesson, string(pj), c.Pointer, c.About, c.Context, e.Ref, e.Milestone,
		hash, at, ord, ord, ord, core, strength, fadeAt, archiveAt, reviewed, state, e.Corrects); err != nil {
		return err
	}
	if kept {
		rest := strings.Join(append([]string{c.Body, c.Outcome, c.Feeling, c.Lesson, c.Pointer, c.About, c.Context}, people...), "\n")
		if _, err := tx.ExecContext(ctx, `INSERT INTO memories_fts(rowid, gist, rest) VALUES(?, ?, ?)`,
			seq, indexText(c.Gist), indexText(rest)); err != nil {
			return err
		}
	}
	for _, src := range e.From {
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO links(src, dst) VALUES(?, ?)`, e.ID, src); err != nil {
			return err
		}
	}

	// What the new memory takes the place of stays in the record and leaves
	// ordinary recall.
	replace := func(where string, args ...any) error {
		_, err := tx.ExecContext(ctx,
			`UPDATE memories SET state = ?, state_by = ? WHERE state = '' AND id <> ? AND `+where,
			append([]any{StateSuperseded, e.ID, e.ID}, args...)...)
		return err
	}
	switch {
	case e.Corrects != "":
		err = replace(`id = ?`, e.Corrects)
	case kind == KindSelf && e.Ref != "":
		err = replace(`id = ? AND kind = ?`, e.Ref, KindSelf)
	case kind == KindImpression && kept:
		err = replace(`kind = ? AND about = ?`, KindImpression, c.About)
	case kind == KindEpisode:
		// The fragments it was put together from are now part of it.
		for _, src := range e.From {
			if _, err = tx.ExecContext(ctx,
				`UPDATE memories SET state = ?, state_by = ?, reviewed = ? WHERE id = ? AND kind = ? AND state = ''`,
				StateAbsorbed, e.ID, ord, src, KindFragment); err != nil {
				break
			}
		}
	}
	if err != nil {
		return err
	}
	return sessionActive(ctx, tx, e.Session, at)
}

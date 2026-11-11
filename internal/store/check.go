package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
)

// A check looks a memory over from several sides and says what it finds
// without quoting what any memory says: figures, and the ids of memories
// worth a second look. It is how a memory is examined by its owner, or by
// whoever tests the system, without anyone reading it.

// Levels of a finding.
const (
	LevelProblem = "problem" // the record is damaged or the tables disagree with it
	LevelWarning = "warning" // it works, and something about how it is used looks off
	LevelNote    = "note"    // worth knowing
)

// Thresholds of the usage checks. They are starting values.
const (
	checkManyWrites    = 20   // moments written by one conversation
	checkMinSample     = 20   // below this, shares say little
	checkCoreShare     = 0.3  // of standing memories that never fade
	checkStrongShare   = 0.2  // of fragments felt at 0.9 or above
	checkLongBody      = 3000 // characters
	checkBacklog       = 50   // fragments waiting for reflect
	checkIDsPerFinding = 20
)

// Finding is one thing a check noticed.
type Finding struct {
	Level string
	Code  string
	Text  string
	IDs   []string // memories or sessions concerned, at most a handful
}

// Figure is one fact a check reports.
type Figure struct{ Name, Value string }

// Report is the outcome of a check.
type Report struct {
	Figures  []Figure
	Findings []Finding
}

// Count reports how many findings have the given level.
func (r Report) Count(level string) int {
	n := 0
	for _, f := range r.Findings {
		if f.Level == level {
			n++
		}
	}
	return n
}

// String lays the report out as text.
func (r Report) String() string {
	var b strings.Builder
	for _, f := range r.Figures {
		fmt.Fprintf(&b, "%s: %s\n", f.Name, f.Value)
	}
	for _, level := range []string{LevelProblem, LevelWarning, LevelNote} {
		fmt.Fprintf(&b, "%ss: ", level)
		if r.Count(level) == 0 {
			b.WriteString("none\n")
			continue
		}
		b.WriteByte('\n')
		for _, f := range r.Findings {
			if f.Level != level {
				continue
			}
			fmt.Fprintf(&b, "  [%s] %s", f.Code, f.Text)
			if len(f.IDs) > 0 {
				fmt.Fprintf(&b, ": %s", strings.Join(f.IDs, ", "))
			}
			b.WriteByte('\n')
		}
	}
	return b.String()
}

type checker struct {
	ctx context.Context
	q   *sql.DB
	r   Report
	err error
}

func (c *checker) figure(name, format string, args ...any) {
	c.r.Figures = append(c.r.Figures, Figure{name, fmt.Sprintf(format, args...)})
}

func (c *checker) find(level, code string, ids []string, format string, args ...any) {
	if len(ids) > checkIDsPerFinding {
		ids = append(ids[:checkIDsPerFinding:checkIDsPerFinding], fmt.Sprintf("and %d more", len(ids)-checkIDsPerFinding))
	}
	c.r.Findings = append(c.r.Findings, Finding{Level: level, Code: code, Text: fmt.Sprintf(format, args...), IDs: ids})
}

// one reads a single number.
func (c *checker) one(query string, args ...any) int64 {
	var n sql.NullInt64
	if c.err == nil {
		c.err = c.q.QueryRowContext(c.ctx, query, args...).Scan(&n)
	}
	return n.Int64
}

// list reads a column of strings.
func (c *checker) list(query string, args ...any) []string {
	if c.err != nil {
		return nil
	}
	rows, err := c.q.QueryContext(c.ctx, query, args...)
	if err != nil {
		c.err = err
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if c.err = rows.Scan(&s); c.err != nil {
			return nil
		}
		out = append(out, s)
	}
	c.err = rows.Err()
	return out
}

// flag adds a finding when the query returns any ids.
func (c *checker) flag(level, code, text, query string, args ...any) {
	if ids := c.list(query, args...); len(ids) > 0 {
		c.find(level, code, ids, "%d %s", len(ids), text)
	}
}

// Check examines the memory. It reads and changes nothing. It works on a
// store opened with LogOnly, as long as the derived tables have been built.
func (s *Store) Check(ctx context.Context) (Report, error) {
	c := &checker{ctx: ctx, q: s.r}
	c.checkLog()
	if c.err == nil && c.one(`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'memories'`) == 0 {
		c.find(LevelNote, "not-built", nil, "the derived tables have not been built yet, so only the log was checked; serve the memory once, or run rebuild")
		return c.r, c.err
	}
	c.checkTables()
	c.checkUse()
	return c.r, c.err
}

// checkLog checks the record itself: the events and what the memories say.
func (c *checker) checkLog() {
	format, _, err := getMeta(c.ctx, c.q, metaLogFormat)
	if c.err == nil {
		c.err = err
	}
	c.figure("log", "format %s, %d events: %d sessions, %d memories written, %d listings, %d readings, %d amendments, %d rounds of reflection, %d erased, %d restores",
		format, c.one(`SELECT count(*) FROM events`),
		c.one(`SELECT count(*) FROM events WHERE kind = ?`, kindSession), c.one(`SELECT count(*) FROM events WHERE kind = ?`, kindRemember),
		c.one(`SELECT count(*) FROM events WHERE kind = ?`, kindRecall), c.one(`SELECT count(*) FROM events WHERE kind = ?`, kindExpand),
		c.one(`SELECT count(*) FROM events WHERE kind = ?`, kindAmend), c.one(`SELECT count(*) FROM events WHERE kind = ?`, kindReflect),
		c.one(`SELECT count(*) FROM events WHERE kind = ?`, kindErase), c.one(`SELECT count(*) FROM events WHERE kind = ?`, kindRestore))
	if c.err != nil {
		return
	}

	erased := make(map[string]bool)
	for _, id := range c.list(`SELECT json_extract(payload, '$.id') FROM events WHERE kind = ?`, kindErase) {
		erased[id] = true
	}
	rows, err := c.q.QueryContext(c.ctx,
		`SELECT json_extract(e.payload, '$.id'), COALESCE(json_extract(e.payload, '$.hash'), ''), c.data
		   FROM events e LEFT JOIN contents c ON c.id = json_extract(e.payload, '$.id') WHERE e.kind = ? ORDER BY e.seq`, kindRemember)
	if err != nil {
		c.err = err
		return
	}
	defer rows.Close()
	var lost, altered, lingering []string
	for rows.Next() {
		var id, hash string
		var data sql.NullString
		if c.err = rows.Scan(&id, &hash, &data); c.err != nil {
			return
		}
		switch {
		case !data.Valid && !erased[id]:
			lost = append(lost, id)
		case data.Valid && erased[id]:
			lingering = append(lingering, id)
		case data.Valid:
			if sum := sha256.Sum256([]byte(data.String)); hex.EncodeToString(sum[:]) != hash {
				altered = append(altered, id)
			}
		}
	}
	if c.err = rows.Err(); c.err != nil {
		return
	}
	if len(lost) > 0 {
		c.find(LevelProblem, "content-lost", lost, "%d memories have lost what they said, and the log holds no erasure for them", len(lost))
	}
	if len(altered) > 0 {
		c.find(LevelProblem, "content-altered", altered, "%d memories say something other than what was written: the content does not match the hash in the log", len(altered))
	}
	if len(lingering) > 0 {
		c.find(LevelProblem, "erase-incomplete", lingering, "%d erased memories still have their content in the file", len(lingering))
	}
	if n := c.one(`SELECT count(*) FROM contents c WHERE NOT EXISTS
		(SELECT 1 FROM events e WHERE e.kind = ? AND json_extract(e.payload, '$.id') = c.id)`, kindRemember); n > 0 {
		c.find(LevelProblem, "content-orphaned", nil, "%d pieces of content belong to no memory in the log", n)
	}
	c.flag(LevelProblem, "session-unknown", "memories were written in a conversation the log does not know",
		`SELECT json_extract(payload, '$.id') FROM events WHERE kind = ?1 AND json_extract(payload, '$.session') NOT IN
		   (SELECT json_extract(payload, '$.id') FROM events WHERE kind = ?2)`, kindRemember, kindSession)
}

// checkTables checks that the derived tables agree with the log and with
// themselves.
func (c *checker) checkTables() {
	written := c.one(`SELECT count(*) FROM events WHERE kind = ?`, kindRemember)
	if have := c.one(`SELECT count(*) FROM memories`); have != written {
		c.find(LevelProblem, "tables-stale", nil, "the tables hold %d memories and the log %d: run rebuild", have, written)
	}
	lived := c.one(`SELECT count(*) FROM events WHERE kind = ?1 AND COALESCE(json_extract(payload, '$.kind'), '') = ''
		AND COALESCE(json_extract(payload, '$.corrects'), '') = '' AND json_extract(payload, '$.source') <> ?2`, kindRemember, SourceReconstructed)
	clock := c.one(`SELECT COALESCE(MAX(ord), 0) FROM memories`)
	if clock != lived {
		c.find(LevelProblem, "clock-off", nil, "the experience clock reads %d and the log holds %d moments written as they happened: run rebuild", clock, lived)
	}
	c.flag(LevelProblem, "link-broken", "memories point at a memory that does not exist",
		`SELECT m.id FROM memories m WHERE (m.state_by <> '' AND m.state_by NOT IN (SELECT id FROM memories))
		    OR (m.corrects <> '' AND m.corrects NOT IN (SELECT id FROM memories))
		    OR (m.ref <> '' AND m.ref NOT IN (SELECT id FROM memories))
		 UNION SELECT l.src FROM links l WHERE l.dst NOT IN (SELECT id FROM memories) OR l.src NOT IN (SELECT id FROM memories)`)
	c.flag(LevelWarning, "nothing-in-its-place", "memories were replaced or absorbed by one that no longer stands",
		`SELECT m.id FROM memories m JOIN memories by ON by.id = m.state_by
		  WHERE m.state IN (?1, ?2) AND m.retracted = 0 AND (by.retracted = 1 OR by.state = ?3)`, StateSuperseded, StateAbsorbed, StateErased)
	c.flag(LevelWarning, "self-unsupported", "statements about yourself rest on experiences that were retracted or erased since",
		`SELECT DISTINCT m.id FROM memories m JOIN links l ON l.src = m.id JOIN memories d ON d.id = l.dst
		  WHERE m.kind = ?1 AND `+isLive+` AND (d.retracted = 1 OR d.state = ?2)`, KindSelf, StateErased)
	if n := c.one(`SELECT count(*) FROM vectors v WHERE v.n NOT IN (SELECT n FROM memories)`); n > 0 {
		c.find(LevelNote, "vector-orphaned", nil, "%d embeddings belong to no memory", n)
	}

	const standing = `FROM memories m WHERE ` + isLive + ` AND ` + isListed
	t := func(cond string) int64 { return c.one(`SELECT count(*) `+standing+` AND `+cond, clock, clock) }
	c.figure("memories", "%d standing (%d core, %d active, %d faded, %d archived), %d set aside or part of another; the clock reads %d",
		c.one(`SELECT count(*) `+standing), c.one(`SELECT count(*) `+standing+` AND m.core = 1`),
		c.one(`SELECT count(*) `+standing+` AND `+isActiveBand, clock), t(isFadedBand),
		c.one(`SELECT count(*) `+standing+` AND `+isArchived, clock),
		c.one(`SELECT count(*) FROM memories m WHERE NOT `+isLive), clock)
	kinds := c.list(`SELECT kind || ' ' || count(*) ` + standing + ` GROUP BY kind ORDER BY count(*) DESC`)
	sources := c.list(`SELECT source || ' ' || count(*) FROM memories m WHERE ` + isLive + ` GROUP BY source ORDER BY count(*) DESC`)
	c.figure("by kind", "%s", strings.Join(kinds, ", "))
	c.figure("by source", "%s", strings.Join(sources, ", "))
	c.figure("about yourself", "%d statements stand, %d earlier versions kept",
		c.one(`SELECT count(*) FROM memories m WHERE m.kind = ? AND `+isLive, KindSelf),
		c.one(`SELECT count(*) FROM memories m WHERE m.kind = ? AND m.state = ?`, KindSelf, StateSuperseded))
	c.figure("preferences", "%d in force, %d retired", c.one(`SELECT count(*) FROM policies WHERE retired_at IS NULL`),
		c.one(`SELECT count(*) FROM policies WHERE retired_at IS NOT NULL`))
}

// checkUse looks at how the memory is being used.
func (c *checker) checkUse() {
	const standing = `FROM memories m WHERE ` + isLive + ` AND ` + isListed
	total := c.one(`SELECT count(*) ` + standing)

	busy := c.list(`SELECT session_id || ' (' || count(*) || ')' FROM memories WHERE kind = ?1 AND source <> ?2
		GROUP BY session_id HAVING count(*) > ?3 ORDER BY count(*) DESC`, KindFragment, SourceReconstructed, checkManyWrites)
	if len(busy) > 0 {
		c.find(LevelWarning, "many-writes", busy, "%d conversations wrote more than %d moments each; most turns need no memory, and every moment pushes older ones away", len(busy), checkManyWrites)
	}
	if core := c.one(`SELECT count(*) ` + standing + ` AND m.core = 1`); total >= checkMinSample && float64(core) > checkCoreShare*float64(total) {
		c.find(LevelWarning, "core-inflated", nil, "%d of %d standing memories never fade; if most things are kept for good, importance says little", core, total)
	}
	fragments := c.one(`SELECT count(*) FROM memories WHERE kind = ?`, KindFragment)
	if strong := c.one(`SELECT count(*) FROM memories WHERE kind = ? AND intensity >= 0.9`, KindFragment); fragments >= checkMinSample && float64(strong) > checkStrongShare*float64(fragments) {
		c.find(LevelWarning, "feeling-inflated", nil, "%d of %d moments were felt at 0.9 or above; a feeling is for what actually registered", strong, fragments)
	}
	c.flag(LevelWarning, "looks-like-project-notes", "memories hold code or run very long; an account of what was lived through rarely does, and the work itself belongs in its repository",
		`SELECT m.id `+standing+` AND (m.body LIKE '%' || char(96, 96, 96) || '%' OR length(m.body) > ?) ORDER BY m.n`, checkLongBody)
	c.flag(LevelWarning, "same-gist", "standing memories share their gist word for word with another",
		`SELECT m.id `+standing+` AND m.gist IN (SELECT gist FROM memories m WHERE `+isLive+` AND `+isListed+` GROUP BY gist HAVING count(*) > 1) ORDER BY m.gist, m.n`)
	if pending := c.one(`SELECT count(*) FROM memories m WHERE m.kind = ? AND `+isLive+` AND m.reviewed IS NULL`, KindFragment); pending >= checkBacklog {
		c.find(LevelWarning, "backlog", nil, "%d moments have not been reflected on", pending)
	} else {
		c.figure("waiting for reflect", "%d", pending)
	}
	if n := c.one(`SELECT count(*) FROM (SELECT lower(trim(about)) FROM memories WHERE kind = ? GROUP BY 1 HAVING count(DISTINCT about) > 1)`, KindImpression); n > 0 {
		c.find(LevelNote, "name-variants", nil, "%d people or things have impressions under names that differ only in case or spacing, so they count as different", n)
	}
	if total > 0 {
		c.find(LevelNote, "never-came-to-mind", nil, "%d of %d standing memories have never been listed or read since they were written",
			c.one(`SELECT count(*) `+standing+` AND m.recall_count = 0`), total)
	}
	if n := c.one(`SELECT count(*) FROM restores`); n > 0 {
		c.find(LevelNote, "restored", nil, "this memory was brought back from an export %d time(s); what was lived between an export and its restore is not in it", n)
	}
}

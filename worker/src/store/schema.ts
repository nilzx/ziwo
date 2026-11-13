// The database has two kinds of tables, as in the Go build (schema.go).
//
// The log tables are the record: events is the only source of truth and is
// append-only. vector_rows is kept alongside it because embeddings are
// expensive to recompute. meta holds what describes the memory itself: the log format,
// the access token's hash, the forgetting parameters, and what the derived
// tables were built from, including the experience clock.
//
// The derived tables are a projection of the event log. They are dropped and
// replayed from events whenever derivedVersion or the forgetting parameters
// change.

// logFormat is the format of the event log. See schema.go for its history.
// Older formats are not migrated here: no memory on this platform was ever
// written in one.
export const logFormat = 3;

// derivedVersion identifies the layout of the derived tables and the logic
// that fills them. Bump it whenever either changes. The Go build stands at 6;
// 7 added the indexes a new session's load reads; 8 projects amend, erase and
// reflect events, and replays an erasure the way it was lived (see
// applyRemember and applyErase); 9 keeps the time zone a session reported;
// 10 keys a carrier by one spelling of its name (see carrierKey); 11 indexes
// what replaced a memory (state_by), which expand shows with the new memory;
// 12 files items under subjects (subject, subjects, subject_names), keeps when
// a session last wrote a fragment, and leaves subject items out of what is
// listed.
export const derivedVersion = "12";

// appendOnlyTriggers make the database itself refuse to change or remove an
// event.
export const appendOnlyTriggers = `
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
`;

export const logSchema =
  `
CREATE TABLE IF NOT EXISTS events (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL, -- unix milliseconds
  kind    TEXT    NOT NULL,
  payload TEXT    NOT NULL  -- JSON
) STRICT;

-- Embeddings, packed: see vectors.ts. Up to 256 vectors a row, each as
-- dims signed bytes (the unit vector times 127, rounded), in vecs; the
-- memories' row numbers beside them in ns, as little-endian int32, in the
-- same order.
CREATE TABLE IF NOT EXISTS vector_rows (
  pack  INTEGER PRIMARY KEY,
  model TEXT    NOT NULL, -- the embedding model that made the vectors
  dims  INTEGER NOT NULL, -- their size
  count INTEGER NOT NULL, -- how many the row holds
  ns    BLOB    NOT NULL, -- count * 4 bytes
  vecs  BLOB    NOT NULL  -- count * dims bytes
) STRICT;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- What each memory says. It is written once, with the event that records the
-- memory, and never changed. It can be deleted: that is how a memory's
-- content is erased for good while the log still shows that it existed.
CREATE TABLE IF NOT EXISTS contents (
  id   TEXT PRIMARY KEY, -- the memory's id
  data TEXT NOT NULL     -- JSON; see Content in content.ts
) STRICT, WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS contents_no_update BEFORE UPDATE ON contents
BEGIN SELECT RAISE(ABORT, 'content is written once'); END;
` + appendOnlyTriggers;

// The derived tables other than the keyword index, which is cleared rather
// than dropped: see indexSchema.
export const dropDerived = `
DROP TABLE IF EXISTS subject_names;
DROP TABLE IF EXISTS subjects;
DROP TABLE IF EXISTS restores;
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS policies;
DROP TABLE IF EXISTS memories;
DROP TABLE IF EXISTS carriers;
DROP TABLE IF EXISTS sessions;
`;

export const derivedSchema = `
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  started_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL, -- last time it started, wrote or recalled
  model          TEXT    NOT NULL, -- self-reported by the model; '' when unknown
  client         TEXT    NOT NULL, -- MCP client name; '' when unknown
  tz             TEXT    NOT NULL, -- IANA time zone the model reported; '' when none
  wrote_at       INTEGER NOT NULL, -- last time it wrote a fragment; 0 when it wrote none
  burst_n        INTEGER NOT NULL, -- row number of the first fragment of its current burst; 0 when it wrote none
  wrote_n        INTEGER NOT NULL  -- fragments it wrote as they happened (not reconstructed, not corrections)
) STRICT;
CREATE INDEX sessions_by_activity ON sessions(last_active_at);
CREATE INDEX sessions_by_wrote ON sessions(wrote_at);

-- One row per model that has ever loaded this memory.
CREATE TABLE carriers (
  model      TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  sessions   INTEGER NOT NULL
) STRICT;

CREATE TABLE memories (
  n                INTEGER PRIMARY KEY, -- seq of the event that created it
  id               TEXT    NOT NULL UNIQUE,
  created_at       INTEGER NOT NULL, -- when it happened
  written_at       INTEGER NOT NULL, -- when it was written; later, for what was reconstructed
  session_id       TEXT    NOT NULL,
  kind             TEXT    NOT NULL, -- fragment, episode, lesson, impression, self, reading or subject
  moment           TEXT    NOT NULL,
  source           TEXT    NOT NULL,
  importance       REAL    NOT NULL,
  intensity        REAL    NOT NULL, -- how strongly it registered, 0 to 1
  gist             TEXT    NOT NULL,
  body             TEXT    NOT NULL,
  outcome          TEXT    NOT NULL,
  feeling          TEXT    NOT NULL,
  lesson           TEXT    NOT NULL,
  people           TEXT    NOT NULL, -- JSON array of names
  pointer          TEXT    NOT NULL,
  about            TEXT    NOT NULL, -- impression: who or what it is about; subject: its name
  context          TEXT    NOT NULL, -- self: the situation the statement holds in
  ref              TEXT    NOT NULL, -- self: the statement it revises; reading: the memory it reads
  milestone        INTEGER NOT NULL, -- 0 or 1; marked as a milestone when reflected on
  hash             TEXT    NOT NULL,
  last_recalled_at INTEGER NOT NULL,
  recall_count     INTEGER NOT NULL, -- times listed or read
  -- Forgetting. See decay.ts. The clock is kept in meta: the number of
  -- moments written as they happened. A memory that did not advance the
  -- clock has the ord the clock read when it was written.
  ord              INTEGER NOT NULL,
  touched_ord      INTEGER NOT NULL, -- clock when it last came to mind: listed or read
  read_ord         INTEGER NOT NULL, -- clock when it was last read in full
  core             INTEGER NOT NULL, -- 0 or 1; a core memory never fades
  strength         REAL    NOT NULL, -- counted in memories
  fade_at          REAL,             -- clock value from which only the gist stays findable
  archive_at       REAL,             -- clock value from which it leaves ordinary search
  reviewed         INTEGER,          -- clock when reflect dealt with it; NULL while a fragment waits
  -- Standing. A memory is live when state is '' and retracted is 0.
  state            TEXT    NOT NULL, -- '', superseded, absorbed or erased
  state_by         TEXT    NOT NULL, -- id of the memory that replaced or absorbed it, or ''
  retracted        INTEGER NOT NULL, -- 0 or 1; set aside on request, can be restored
  pinned           INTEGER NOT NULL, -- 0 or 1; kept as core on request
  corrects         TEXT    NOT NULL, -- id of the memory this one corrects, or ''
  subject          TEXT    NOT NULL  -- fragment, episode, lesson: the head of its subject, or '';
                                     -- subject item: the head of its subject (itself while it stands);
                                     -- '' for every other kind, and once erased
) STRICT;
CREATE INDEX memories_by_hash ON memories(hash, written_at);
CREATE INDEX memories_by_archive ON memories(archive_at) WHERE core = 0;
CREATE INDEX memories_by_kind ON memories(kind, about);
CREATE INDEX memories_by_ref ON memories(ref) WHERE ref <> '';
-- The items of a subject ('' for those of none), and what they are.
CREATE INDEX memories_by_subject ON memories(subject, kind, state, retracted);
-- What every new session reads: the tier counts, the newest memories, the
-- core ones, and how many fragments wait. Each index holds only the memories
-- its query is about, in the order the query wants them, so loading does not
-- walk the whole table. Their conditions are those in conditions.ts. The
-- kinds left out are written as one comparison each: SQLite looks a NOT IN
-- of three values up in a table of its own, which costs a row read for
-- every memory it is asked of.
CREATE INDEX memories_standing_tiers ON memories(core, fade_at, archive_at)
  WHERE state = '' AND retracted = 0 AND kind <> 'self' AND kind <> 'reading' AND kind <> 'subject';
CREATE INDEX memories_standing_recent ON memories(created_at DESC, n DESC)
  WHERE state = '' AND retracted = 0 AND kind <> 'self' AND kind <> 'reading' AND kind <> 'subject';
CREATE INDEX memories_standing_core ON memories(pinned DESC, importance DESC, intensity DESC, n DESC)
  WHERE core = 1 AND state = '' AND retracted = 0 AND kind <> 'self' AND kind <> 'reading' AND kind <> 'subject';
-- What waits for reflect, by subject ('' for unsorted), nearest to fading first; with the
-- session that wrote it, so that ripeness is read from the index alone.
CREATE INDEX memories_pending ON memories(subject, core, fade_at, n, session_id)
  WHERE kind = 'fragment' AND state = '' AND retracted = 0 AND reviewed IS NULL;

-- What replaced or absorbed a memory, looked up from the new memory.
CREATE INDEX memories_by_state_by ON memories(state_by) WHERE state_by <> '';

-- What a memory is built on: src cites dst.
CREATE TABLE links (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  PRIMARY KEY (src, dst)
) STRICT, WITHOUT ROWID;
CREATE INDEX links_by_dst ON links(dst);

-- Each subject, by the subject item that stands for it.
CREATE TABLE subjects (
  id        TEXT    PRIMARY KEY,      -- the head
  n         INTEGER NOT NULL UNIQUE,  -- its row number in memories
  active_at INTEGER NOT NULL          -- the latest time something was written into it, unix ms
) STRICT;
CREATE INDEX subjects_by_activity ON subjects(active_at, n);

-- The keys of the names subject items were written with, to resolve a name
-- when something is written. A replay never resolves a name: this table is
-- read only by writes.
CREATE TABLE subject_names (
  key TEXT NOT NULL,  -- subjectKey of the name
  id  TEXT NOT NULL,  -- the subject item written with it
  PRIMARY KEY (key, id)
) STRICT, WITHOUT ROWID;
CREATE INDEX subject_names_by_id ON subject_names(id);

-- Standing rules about what to remember, set in conversation.
CREATE TABLE policies (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  session_id TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  retired_at INTEGER -- NULL while in force
) STRICT;

-- Each time this memory was brought back from an export.
CREATE TABLE restores (
  at          INTEGER PRIMARY KEY, -- when it was brought back
  exported_at INTEGER NOT NULL,    -- when the export was made
  events      INTEGER NOT NULL     -- how many events the export held
) STRICT;
`;

// The keyword index is a derived table too, but it is created apart from the
// others and emptied, not dropped, when they are rebuilt. On this platform,
// rolling back a transaction that created an FTS5 table and wrote to it does
// not throw: the whole object is reset to its last stored state. A replay
// that fails must roll back like any other write, so the index always exists
// before the transaction that fills it.
//
// indexVersion identifies the definition below. Bump it whenever the
// definition changes: the index is then dropped, created again and refilled.
export const indexVersion = "2";

export const dropIndex = `DROP TABLE IF EXISTS memories_fts; DROP TABLE IF EXISTS subjects_fts;`;

export const indexSchema = `
-- Keyword index. rowid = memories.n. Contentless: the text lives in memories.
-- The gist has a column of its own because a faded memory is matched on its
-- gist alone.
CREATE VIRTUAL TABLE memories_fts USING fts5(
  gist, rest, content='', contentless_delete=1, tokenize='unicode61'
);
-- Subjects, by name and description. rowid = memories.n of the subject item.
-- Kept apart from memories_fts so that subjects take no part in how items rank.
CREATE VIRTUAL TABLE subjects_fts USING fts5(
  name, description, content='', contentless_delete=1, tokenize='unicode61'
);
`;

export const clearIndex = `INSERT INTO memories_fts(memories_fts) VALUES('delete-all');
INSERT INTO subjects_fts(subjects_fts) VALUES('delete-all');`;

// Keys of the meta table. The first four are as in Go (format.go); the rest
// are new on this platform.
export const metaLogFormat = "log_format";
export const metaDerived = "derived";
export const metaTokenHash = "token_sha256";
export const metaInstance = "instance"; // names this memory, to tell it from a copy
export const metaParams = "params"; // the forgetting parameters, as JSON
export const metaClock = "clock"; // the experience clock; derived, kept by apply
export const metaIndex = "index"; // the indexVersion the keyword index was created with
// The time zone shown to a call whose session reported none; UTC when unset.
export const metaZone = "timezone";
// The open round of reflection, as in Go (reflect.go). It is working state,
// not memory: it is not in the log, and a rebuild leaves it as it is.
export const metaReflect = "reflect";
// The sessions already asked to reflect, as a JSON array of session ids,
// newest last. Working state as well: not in the log, kept by a rebuild.
export const metaPrompted = "prompted";
// What the alarm that embeds keeps about its runs (see embedding.ts). Working
// state too, not memory: a rebuild leaves it as it is.
export const metaVectorsSeen = "vectors_seen"; // the highest row number an ordinary run has dealt with
export const metaVectorsFull = "vectors_full"; // "1" while a full run is asked for
export const metaVectorsFullAt = "vectors_full_at"; // wall clock of the last full run, unix ms
export const metaVectorsLabel = "vectors_label"; // the label of the last full run: model and size

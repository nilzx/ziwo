package store

// The database has two kinds of tables.
//
// The log tables are the record: events is the only source of truth and is
// append-only. vectors is kept alongside it because embeddings are expensive
// to recompute, although they too can be rebuilt. meta holds what describes
// the file itself: the log format, the access token's hash, and what the
// derived tables were built from.
//
// The derived tables are a projection of the event log. They are dropped and
// replayed from events whenever derivedVersion or the forgetting parameters
// change, so their layout can change freely between releases.

// logFormat is the format of the event log: which kinds of event exist and
// what their payloads hold. The log is the one thing that cannot be rebuilt,
// so its format is versioned. A file written in an older format is upgraded
// by the migrations in format.go; a file written in a newer one is refused.
//
//	0  before the format was versioned. Reading a memory in full was logged
//	   as a "recall" event without a query.
//	1  "recall" lists memories; reading in full is its own "expand" event.
//	2  What a memory says is no longer in its event. It lives in the contents
//	   table, where it can be erased for good; the event keeps its hash.
//	   New kinds of event: "amend", "erase", "reflect". A remember event may
//	   say what kind of memory it records, what it is built on, and when the
//	   thing happened if that was not when it was written.
//	3  New kind of event: "restore", written when a memory is brought back
//	   from an export.
const logFormat = 3

// derivedVersion identifies the layout of the derived tables and the logic
// that fills them. Bump it whenever either changes.
const derivedVersion = "6"

const logSchema = `
CREATE TABLE IF NOT EXISTS events (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL, -- unix milliseconds
  kind    TEXT    NOT NULL,
  payload TEXT    NOT NULL  -- JSON
) STRICT;

CREATE TABLE IF NOT EXISTS vectors (
  n     INTEGER NOT NULL, -- memories.n
  model TEXT    NOT NULL, -- embedding model that produced vec
  vec   BLOB    NOT NULL, -- little-endian float32
  PRIMARY KEY (n, model)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- What each memory says. It is written once, with the event that records the
-- memory, and never changed. It can be deleted: that is how a memory's
-- content is erased for good while the log still shows that it existed.
CREATE TABLE IF NOT EXISTS contents (
  id   TEXT PRIMARY KEY, -- the memory's id
  data TEXT NOT NULL     -- JSON; see content in content.go
) STRICT, WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS contents_no_update BEFORE UPDATE ON contents
BEGIN SELECT RAISE(ABORT, 'content is written once'); END;
` + appendOnlyTriggers

// appendOnlyTriggers make the database itself refuse to change or remove an
// event. A format migration is the one thing that lifts them, inside its own
// transaction.
const appendOnlyTriggers = `
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
`

const dropAppendOnlyTriggers = `
DROP TRIGGER IF EXISTS events_no_update;
DROP TRIGGER IF EXISTS events_no_delete;
`

const dropDerived = `
DROP TABLE IF EXISTS restores;
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS policies;
DROP TABLE IF EXISTS memories_fts;
DROP TABLE IF EXISTS memories;
DROP TABLE IF EXISTS carriers;
DROP TABLE IF EXISTS sessions;
`

const derivedSchema = `
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  started_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL, -- last time it started, wrote or recalled
  model          TEXT    NOT NULL, -- self-reported by the model; '' when unknown
  client         TEXT    NOT NULL  -- MCP client name; '' when unknown
) STRICT;
CREATE INDEX sessions_by_activity ON sessions(last_active_at);

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
  kind             TEXT    NOT NULL, -- fragment, episode, lesson, impression, self or reading
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
  about            TEXT    NOT NULL, -- impression: who or what it is about
  context          TEXT    NOT NULL, -- self: the situation the statement holds in
  ref              TEXT    NOT NULL, -- self: the statement it revises; reading: the memory it reads
  milestone        INTEGER NOT NULL, -- 0 or 1; marked as a milestone when reflected on
  hash             TEXT    NOT NULL,
  last_recalled_at INTEGER NOT NULL,
  recall_count     INTEGER NOT NULL, -- times listed or read
  -- Forgetting. See decay.go. The clock is the largest ord: the number of
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
  corrects         TEXT    NOT NULL  -- id of the memory this one corrects, or ''
) STRICT;
CREATE INDEX memories_by_hash ON memories(hash, written_at);
CREATE INDEX memories_by_archive ON memories(archive_at) WHERE core = 0;
CREATE INDEX memories_by_kind ON memories(kind, about);
CREATE INDEX memories_by_ref ON memories(ref) WHERE ref <> '';

-- What a memory is built on: src cites dst.
CREATE TABLE links (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  PRIMARY KEY (src, dst)
) STRICT, WITHOUT ROWID;
CREATE INDEX links_by_dst ON links(dst);

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

-- Keyword index. rowid = memories.n. Contentless: the text lives in memories.
-- The gist has a column of its own because a faded memory is matched on its
-- gist alone.
CREATE VIRTUAL TABLE memories_fts USING fts5(
  gist, rest, content='', contentless_delete=1, tokenize='unicode61'
);
`

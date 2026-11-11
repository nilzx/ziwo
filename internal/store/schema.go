package store

// The database has two kinds of tables.
//
// The log tables are the record: events is the only source of truth and can
// never be updated or deleted from. vectors is kept alongside it because
// embeddings are expensive to recompute, although they too can be rebuilt.
//
// The derived tables are a projection of the event log. They are dropped and
// replayed from events whenever derivedVersion changes, so their layout can
// change freely between releases without migrations.

// derivedVersion identifies the layout of the derived tables and the logic
// that fills them. Bump it whenever either changes. The forgetting parameters
// are tracked alongside it, so a change to them also triggers a replay.
const derivedVersion = "2"

const logSchema = `
CREATE TABLE IF NOT EXISTS events (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL, -- unix milliseconds
  kind    TEXT    NOT NULL,
  payload TEXT    NOT NULL  -- JSON
) STRICT;

CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

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
`

const dropDerived = `
DROP TABLE IF EXISTS memories_fts;
DROP TABLE IF EXISTS memories;
DROP TABLE IF EXISTS carriers;
DROP TABLE IF EXISTS sessions;
`

const derivedSchema = `
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  model      TEXT    NOT NULL, -- self-reported by the model; '' when unknown
  client     TEXT    NOT NULL  -- MCP client name; '' when unknown
) STRICT;
CREATE INDEX sessions_by_client ON sessions(client, started_at);

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
  created_at       INTEGER NOT NULL,
  session_id       TEXT    NOT NULL,
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
  hash             TEXT    NOT NULL,
  last_recalled_at INTEGER NOT NULL,
  recall_count     INTEGER NOT NULL,
  -- Forgetting. See decay.go. A core memory never fades and has no crossings.
  core             INTEGER NOT NULL, -- 0 or 1
  strength         REAL    NOT NULL, -- days
  fade_at          INTEGER,          -- when only the gist stays findable
  archive_at       INTEGER           -- when it leaves ordinary search
) STRICT;
CREATE INDEX memories_by_hash ON memories(hash, created_at);
CREATE INDEX memories_by_archive ON memories(archive_at) WHERE core = 0;

-- Keyword index. rowid = memories.n. Contentless: the text lives in memories.
-- The gist has a column of its own because a faded memory is matched on its
-- gist alone.
CREATE VIRTUAL TABLE memories_fts USING fts5(
  gist, rest, content='', contentless_delete=1, tokenize='unicode61'
);
`

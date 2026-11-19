// Persona maintenance is separate from the autobiographical event log.
export const personaSchema = `
CREATE TABLE IF NOT EXISTS persona_versions (
  version INTEGER PRIMARY KEY, record TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS persona_current (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS persona_evaluations (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, record TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS persona_proposals (
  id TEXT PRIMARY KEY, record TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS persona_confirmations (
  id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, digest TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approve', 'reject')), at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS persona_confirmations_no_update BEFORE UPDATE ON persona_confirmations
BEGIN SELECT RAISE(ABORT, 'persona confirmations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS persona_confirmations_no_delete BEFORE DELETE ON persona_confirmations
BEGIN SELECT RAISE(ABORT, 'persona confirmations are immutable'); END;
`;

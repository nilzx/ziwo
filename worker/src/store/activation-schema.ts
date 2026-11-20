// Initialization and source receipts survive replay and backup restore.
export const activationSchema = `
CREATE TABLE IF NOT EXISTS activations (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS history_receipts (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS activation_requests (
  id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS activation_revision (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL
) STRICT;
INSERT OR IGNORE INTO activation_revision(singleton, revision) VALUES(1, 0);
CREATE TRIGGER IF NOT EXISTS activations_insert_revision AFTER INSERT ON activations
BEGIN UPDATE activation_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS activations_update_revision AFTER UPDATE ON activations
BEGIN UPDATE activation_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS activations_delete_revision AFTER DELETE ON activations
BEGIN UPDATE activation_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS history_receipts_insert_revision AFTER INSERT ON history_receipts
BEGIN UPDATE activation_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS history_receipts_no_update BEFORE UPDATE ON history_receipts
BEGIN SELECT RAISE(ABORT, 'history receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS history_receipts_no_delete BEFORE DELETE ON history_receipts
BEGIN SELECT RAISE(ABORT, 'history receipts cannot be released'); END;
`;

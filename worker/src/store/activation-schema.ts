// Initialization and source receipts survive replay and backup restore.
export const activationSchema = `
CREATE TABLE IF NOT EXISTS activations (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS history_receipts (id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS activation_requests (
  id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS history_receipts_no_update BEFORE UPDATE ON history_receipts
BEGIN SELECT RAISE(ABORT, 'history receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS history_receipts_no_delete BEFORE DELETE ON history_receipts
BEGIN SELECT RAISE(ABORT, 'history receipts cannot be released'); END;
`;

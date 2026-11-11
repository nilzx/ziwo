// Conditions on memories m, shared by the store's queries and the check.
// They are written with literals, not bound parameters, so that SQLite can
// tell that a query falls within one of the partial indexes in schema.ts.

import { KindFragment, KindReading, KindSelf } from "./content";

// isLive holds for a memory that stands: not replaced, not absorbed, not
// erased, not set aside.
export const isLive = `(m.state = '' AND m.retracted = 0)`;

// isListed holds for the kinds of memory that searches and lists show.
// Statements about oneself are loaded whole at the start of a session, and a
// reading is shown with the memory it reads.
export const isListed = `(m.kind NOT IN ('${KindSelf}', '${KindReading}'))`;

// Conditions on memories m, each taking the clock as its parameter.
export const isArchived = `(m.core = 0 AND m.archive_at <= ?)`;
export const notArchived = `(m.core = 1 OR m.archive_at > ?)`;
export const notYetFaded = `(m.core = 1 OR m.fade_at > ?)`;
export const isFadedBand = `(m.core = 0 AND m.fade_at <= ? AND m.archive_at > ?)`;
export const isActiveBand = `(m.core = 0 AND m.fade_at > ?)`;

// isPending holds for a fragment that waits for reflect.
export const isPending = `(m.kind = '${KindFragment}' AND m.state = '' AND m.retracted = 0 AND m.reviewed IS NULL)`;

// A check looks a memory over from several sides and says what it finds
// without quoting what any memory says: figures, and the ids of memories
// worth a second look. It is how a memory is examined by its owner, or by
// whoever tests the system, without anyone reading it. Port of check.go.

import { KindFragment, KindImpression, KindSelf, SourceReconstructed, StateAbsorbed, StateErased, StateSuperseded } from "./content";
import { type Binding, type Db, text } from "./db";
import { kindAmend, kindErase, kindExpand, kindRecall, kindReflect, kindRemember, kindRestore, kindSession } from "./events";
import { sha256Hex } from "./ids";
import { metaLogFormat } from "./schema";
import { isActiveBand, isArchived, isFadedBand, isListed, isLive, isPending } from "./conditions";
import { VectorRows } from "./vectors";

// Levels of a finding.
export const LevelProblem = "problem"; // the record is damaged or the tables disagree with it
export const LevelWarning = "warning"; // it works, and something about how it is used looks off
export const LevelNote = "note"; // worth knowing

// Thresholds of the usage checks. They are starting values.
export const checkManyWrites = 20; // moments written by one conversation
export const checkMinSample = 20; // below this, shares say little
export const checkCoreShare = 0.3; // of standing memories that never fade
export const checkStrongShare = 0.2; // of fragments felt at 0.9 or above
export const checkLongBody = 3000; // characters
export const checkBacklog = 50; // fragments waiting for reflect
export const checkIDsPerFinding = 20;

// Finding is one thing a check noticed.
export interface Finding {
  level: string;
  code: string;
  text: string;
  ids: string[]; // memories or sessions concerned, at most a handful
}

// Figure is one fact a check reports.
export interface Figure {
  name: string;
  value: string;
}

// Report is the outcome of a check.
export interface Report {
  figures: Figure[];
  findings: Finding[];
}

// countFindings reports how many findings have the given level.
export function countFindings(r: Report, level: string): number {
  return r.findings.filter((f) => f.level === level).length;
}

// reportText lays the report out as text, as Report.String does in Go.
export function reportText(r: Report): string {
  let b = "";
  for (const f of r.figures) b += `${f.name}: ${f.value}\n`;
  for (const level of [LevelProblem, LevelWarning, LevelNote]) {
    b += `${level}s: `;
    if (countFindings(r, level) === 0) {
      b += "none\n";
      continue;
    }
    b += "\n";
    for (const f of r.findings) {
      if (f.level !== level) continue;
      b += `  [${f.code}] ${f.text}`;
      if (f.ids.length > 0) b += `: ${f.ids.join(", ")}`;
      b += "\n";
    }
  }
  return b;
}

class Checker {
  readonly r: Report = { figures: [], findings: [] };

  constructor(readonly db: Db) {}

  figure(name: string, value: string): void {
    this.r.figures.push({ name, value });
  }

  find(level: string, code: string, ids: string[], text: string): void {
    if (ids.length > checkIDsPerFinding) {
      ids = [...ids.slice(0, checkIDsPerFinding), `and ${ids.length - checkIDsPerFinding} more`];
    }
    this.r.findings.push({ level, code, text, ids });
  }

  // one reads a single number; NULL reads as 0, as sql.NullInt64 does.
  one(query: string, ...args: Binding[]): number {
    const row = this.db.first(query, ...args);
    const v = row === undefined ? null : Object.values(row)[0];
    if (v === null || v === undefined) return 0;
    if (typeof v !== "number") throw new Error(`check: expected a number, got ${typeof v}`);
    return v;
  }

  // list reads a column of strings.
  list(query: string, ...args: Binding[]): string[] {
    return this.db.all(query, ...args).map((row) => text(Object.values(row)[0]));
  }

  // flag adds a finding when the query returns any ids.
  flag(level: string, code: string, what: string, query: string, ...args: Binding[]): void {
    const ids = this.list(query, ...args);
    if (ids.length > 0) this.find(level, code, ids, `${ids.length} ${what}`);
  }
}

// checkStore examines the memory. It reads and changes nothing.
export function checkStore(db: Db): Report {
  const c = new Checker(db);
  checkLog(c, db);
  if (c.one(`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'memories'`) === 0) {
    c.find(LevelNote, "not-built", [],
      "the derived tables have not been built yet, so only the log was checked; serve the memory once, or run rebuild");
    return c.r;
  }
  checkTables(c, db);
  checkUse(c);
  return c.r;
}

// checkLog checks the record itself: the events and what the memories say.
function checkLog(c: Checker, db: Db): void {
  const format = db.getMeta(metaLogFormat) ?? "";
  // One pass over the log for all the counts, not one per kind.
  const kinds = new Map<string, number>();
  let events = 0;
  for (const row of db.all(`SELECT kind, count(*) AS c FROM events GROUP BY kind`)) {
    const n = Number(row.c);
    kinds.set(text(row.kind), n);
    events += n;
  }
  const ofKind = (kind: string): number => kinds.get(kind) ?? 0;
  c.figure("log",
    `format ${format}, ${events} events: ${ofKind(kindSession)} sessions, ` +
    `${ofKind(kindRemember)} memories written, ${ofKind(kindRecall)} listings, ${ofKind(kindExpand)} readings, ` +
    `${ofKind(kindAmend)} amendments, ${ofKind(kindReflect)} rounds of reflection, ${ofKind(kindErase)} erased, ` +
    `${ofKind(kindRestore)} restores`);

  const erased = new Set(c.list(`SELECT json_extract(payload, '$.id') FROM events WHERE kind = ?`, kindErase));
  const lost: string[] = [];
  const altered: string[] = [];
  const lingering: string[] = [];
  const said = new Set<string>(); // memories in the log whose content is there
  // One row at a time: this reads every memory's content.
  db.each(
    `SELECT json_extract(e.payload, '$.id') AS id, COALESCE(json_extract(e.payload, '$.hash'), '') AS hash, c.data AS data
       FROM events e LEFT JOIN contents c ON c.id = json_extract(e.payload, '$.id') WHERE e.kind = ? ORDER BY e.seq`,
    [kindRemember],
    (row) => {
      const id = text(row.id);
      const data = row.data === null ? null : text(row.data);
      if (data !== null) said.add(id);
      if (data === null && !erased.has(id)) lost.push(id);
      else if (data !== null && erased.has(id)) lingering.push(id);
      else if (data !== null && sha256Hex(data) !== text(row.hash)) altered.push(id);
    },
  );
  if (lost.length > 0) {
    c.find(LevelProblem, "content-lost", lost,
      `${lost.length} memories have lost what they said, and the log holds no erasure for them`);
  }
  if (altered.length > 0) {
    c.find(LevelProblem, "content-altered", altered,
      `${altered.length} memories say something other than what was written: the content does not match the hash in the log`);
  }
  if (lingering.length > 0) {
    c.find(LevelProblem, "erase-incomplete", lingering, `${lingering.length} erased memories still have their content in the file`);
  }
  // Content that belongs to no memory in the log is what is left of the
  // contents once those seen above are taken away. Go asks the database, for
  // each piece of content, whether some event names it; with no index on a
  // payload's id that reads the whole log once per memory.
  const orphaned = c.one(`SELECT count(*) FROM contents`) - said.size;
  if (orphaned > 0) c.find(LevelProblem, "content-orphaned", [], `${orphaned} pieces of content belong to no memory in the log`);
  c.flag(LevelProblem, "session-unknown", "memories were written in a conversation the log does not know",
    `SELECT json_extract(payload, '$.id') FROM events WHERE kind = ?1 AND json_extract(payload, '$.session') NOT IN
       (SELECT json_extract(payload, '$.id') FROM events WHERE kind = ?2)`, kindRemember, kindSession);
}

// checkTables checks that the derived tables agree with the log and with
// themselves.
function checkTables(c: Checker, db: Db): void {
  const written = c.one(`SELECT count(*) FROM events WHERE kind = ?`, kindRemember);
  const have = c.one(`SELECT count(*) FROM memories`);
  if (have !== written) {
    c.find(LevelProblem, "tables-stale", [], `the tables hold ${have} memories and the log ${written}: run rebuild`);
  }
  const lived = c.one(`SELECT count(*) FROM events WHERE kind = ?1 AND COALESCE(json_extract(payload, '$.kind'), '') = ''
    AND COALESCE(json_extract(payload, '$.corrects'), '') = '' AND json_extract(payload, '$.source') <> ?2`,
    kindRemember, SourceReconstructed);
  // The clock is kept in meta on this platform. Both it and the memories'
  // largest ord must agree with the log; the one in meta is the one every
  // read uses, so it is reported first.
  const clock = db.clock();
  const maxOrd = c.one(`SELECT COALESCE(MAX(ord), 0) FROM memories`);
  if (clock !== lived || maxOrd !== lived) {
    c.find(LevelProblem, "clock-off", [],
      `the experience clock reads ${clock !== lived ? clock : maxOrd} and the log holds ${lived} moments written as they happened: run rebuild`);
  }
  c.flag(LevelProblem, "link-broken", "memories point at a memory that does not exist",
    `SELECT m.id FROM memories m WHERE (m.state_by <> '' AND m.state_by NOT IN (SELECT id FROM memories))
        OR (m.corrects <> '' AND m.corrects NOT IN (SELECT id FROM memories))
        OR (m.ref <> '' AND m.ref NOT IN (SELECT id FROM memories))
     UNION SELECT l.src FROM links l WHERE l.dst NOT IN (SELECT id FROM memories) OR l.src NOT IN (SELECT id FROM memories)`);
  c.flag(LevelWarning, "nothing-in-its-place", "memories were replaced or absorbed by one that no longer stands",
    `SELECT m.id FROM memories m JOIN memories by ON by.id = m.state_by
      WHERE m.state IN (?1, ?2) AND m.retracted = 0 AND (by.retracted = 1 OR by.state = ?3)`,
    StateSuperseded, StateAbsorbed, StateErased);
  c.flag(LevelWarning, "self-unsupported", "statements about yourself rest on experiences that were retracted or erased since",
    `SELECT DISTINCT m.id FROM memories m JOIN links l ON l.src = m.id JOIN memories d ON d.id = l.dst
      WHERE m.kind = ?1 AND ${isLive} AND (d.retracted = 1 OR d.state = ?2)`, KindSelf, StateErased);
  const orphanVectors = c.one(
    `SELECT count(*) FROM json_each(?) WHERE value NOT IN (SELECT n FROM memories)`,
    JSON.stringify(new VectorRows(c.db).storedNs()),
  );
  if (orphanVectors > 0) c.find(LevelNote, "vector-orphaned", [], `${orphanVectors} embeddings belong to no memory`);

  const standing = `FROM memories m WHERE ${isLive} AND ${isListed}`;
  c.figure("memories",
    `${c.one(`SELECT count(*) ${standing}`)} standing (${c.one(`SELECT count(*) ${standing} AND m.core = 1`)} core, ` +
    `${c.one(`SELECT count(*) ${standing} AND ${isActiveBand}`, clock)} active, ` +
    `${c.one(`SELECT count(*) ${standing} AND ${isFadedBand}`, clock, clock)} faded, ` +
    `${c.one(`SELECT count(*) ${standing} AND ${isArchived}`, clock)} archived), ` +
    `${c.one(`SELECT count(*) FROM memories m WHERE NOT ${isLive}`)} set aside or part of another; the clock reads ${clock}`);
  const kinds = c.list(`SELECT kind || ' ' || count(*) ${standing} GROUP BY kind ORDER BY count(*) DESC`);
  const sources = c.list(`SELECT source || ' ' || count(*) FROM memories m WHERE ${isLive} GROUP BY source ORDER BY count(*) DESC`);
  c.figure("by kind", kinds.join(", "));
  c.figure("by source", sources.join(", "));
  c.figure("about yourself",
    `${c.one(`SELECT count(*) FROM memories m WHERE m.kind = ? AND ${isLive}`, KindSelf)} statements stand, ` +
    `${c.one(`SELECT count(*) FROM memories m WHERE m.kind = ? AND m.state = ?`, KindSelf, StateSuperseded)} earlier versions kept`);
  c.figure("preferences",
    `${c.one(`SELECT count(*) FROM policies WHERE retired_at IS NULL`)} in force, ` +
    `${c.one(`SELECT count(*) FROM policies WHERE retired_at IS NOT NULL`)} retired`);
}

// checkUse looks at how the memory is being used.
function checkUse(c: Checker): void {
  const standing = `FROM memories m WHERE ${isLive} AND ${isListed}`;
  const total = c.one(`SELECT count(*) ${standing}`);

  const busy = c.list(`SELECT session_id || ' (' || count(*) || ')' FROM memories WHERE kind = ?1 AND source <> ?2
    GROUP BY session_id HAVING count(*) > ?3 ORDER BY count(*) DESC`, KindFragment, SourceReconstructed, checkManyWrites);
  if (busy.length > 0) {
    c.find(LevelWarning, "many-writes", busy,
      `${busy.length} conversations wrote more than ${checkManyWrites} moments each; most turns need no memory, and every moment pushes older ones away`);
  }
  const core = c.one(`SELECT count(*) ${standing} AND m.core = 1`);
  if (total >= checkMinSample && core > checkCoreShare * total) {
    c.find(LevelWarning, "core-inflated", [],
      `${core} of ${total} standing memories never fade; if most things are kept for good, importance says little`);
  }
  const fragments = c.one(`SELECT count(*) FROM memories WHERE kind = ?`, KindFragment);
  const strong = c.one(`SELECT count(*) FROM memories WHERE kind = ? AND intensity >= 0.9`, KindFragment);
  if (fragments >= checkMinSample && strong > checkStrongShare * fragments) {
    c.find(LevelWarning, "feeling-inflated", [],
      `${strong} of ${fragments} moments were felt at 0.9 or above; a feeling is for what actually registered`);
  }
  c.flag(LevelWarning, "looks-like-project-notes",
    "memories hold code or run very long; an account of what was lived through rarely does, and the work itself belongs in its repository",
    `SELECT m.id ${standing} AND (m.body LIKE '%' || char(96, 96, 96) || '%' OR length(m.body) > ?) ORDER BY m.n`, checkLongBody);
  c.flag(LevelWarning, "same-gist", "standing memories share their gist word for word with another",
    `SELECT m.id ${standing} AND m.gist IN (SELECT gist FROM memories m WHERE ${isLive} AND ${isListed} GROUP BY gist HAVING count(*) > 1)
      ORDER BY m.gist, m.n`);
  const pending = c.one(`SELECT count(*) FROM memories m WHERE ${isPending}`);
  if (pending >= checkBacklog) c.find(LevelWarning, "backlog", [], `${pending} moments have not been reflected on`);
  else c.figure("waiting for reflect", `${pending}`);
  const variants = c.one(`SELECT count(*) FROM (SELECT lower(trim(about)) FROM memories WHERE kind = ? GROUP BY 1
    HAVING count(DISTINCT about) > 1)`, KindImpression);
  if (variants > 0) {
    c.find(LevelNote, "name-variants", [],
      `${variants} people or things have impressions under names that differ only in case or spacing, so they count as different`);
  }
  if (total > 0) {
    c.find(LevelNote, "never-came-to-mind", [],
      `${c.one(`SELECT count(*) ${standing} AND m.recall_count = 0`)} of ${total} standing memories have never been listed or read since they were written`);
  }
  const restores = c.one(`SELECT count(*) FROM restores`);
  if (restores > 0) {
    c.find(LevelNote, "restored", [],
      `this memory was brought back from an export ${restores} time(s); what was lived between an export and its restore is not in it`);
  }
}

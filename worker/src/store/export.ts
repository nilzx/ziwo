// The export format of the Go build (export.go): the event log and what the
// memories say, one JSON object per line: a header, one line per event, a
// footer. Each event line carries a hash chained to the one before, and the
// footer repeats the last, so a file cut short or changed is noticed when it
// is brought back. Derived tables and vectors are left out; they are rebuilt.
//
// Writing gives byte for byte what Go's json.Encoder writes. Reading checks
// what Go's Import checks, reading each line as json.Unmarshal reads it into
// Go's structs, and gives back its messages.

import { createHash } from "node:crypto";
import { type Db, num, text } from "./db";
import type { Params } from "./decay";
import { kindRemember } from "./events";
import { goJSON } from "./json";
import { logFormat, metaInstance, metaTokenHash } from "./schema";

export const exportVersion = 1;

const badExport = "not a usable export";

// ExportError is an export that cannot be brought back as it is, with Go's
// message for it.
export class ExportError extends Error {
  override name = "ExportError";
}

// TooLargeError is an export with more events than one call can bring back.
export class TooLargeError extends Error {
  override name = "TooLargeError";
}

// chain is Go's chain(): SHA-256 over the previous link, the event's seq, at
// and kind, its payload as written, and its content when it has one.
export function chain(prev: string, seq: number, at: number, kind: string, payload: string, content: string | undefined): string {
  const h = createHash("sha256").update(`${prev}\n${seq}\n${at}\n${kind}\n`).update(payload);
  if (content !== undefined) h.update("\n").update(content);
  return h.digest("hex");
}

// goCompact is what Go's encoder does to a json.RawMessage: whitespace
// outside strings is dropped and <, >, &, U+2028 and U+2029 are escaped. A
// payload written by either build is already in that form; one brought back
// from a hand-edited export may not be.
export function goCompact(s: string): string {
  let out = "";
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      else if (c === "<" || c === ">" || c === "&" || c === " " || c === " ") {
        out += s.slice(start, i) + "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
        start = i + 1;
      }
      continue;
    }
    if (c === '"') inString = true;
    else if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      out += s.slice(start, i);
      start = i + 1;
    }
  }
  return out + s.slice(start);
}

// ExportSettings are the settings an export carries in its header. New on
// this platform: Go's import ignores the field.
export interface ExportSettings {
  params: Params;
  timezone: string;
}

// writeExport lays the memory out as an export made at the given time, and
// reports how many events it holds. The caller holds the memory still: it
// reads in one synchronous pass. settings is written last in the header, and
// only when given, so that the export of a memory with default settings is
// what Go writes.
export function writeExport(db: Db, at: number, settings?: ExportSettings): { text: string; events: number } {
  const header = goJSON({
    ziwo_export: exportVersion,
    log_format: logFormat,
    instance: db.getMeta(metaInstance) ?? "",
    exported_at: at,
    settings: settings === undefined ? undefined : { params: { ...orderedParams(settings.params) }, timezone: settings.timezone },
  });
  const parts: string[] = [header + "\n"];
  let head = "";
  let events = 0;
  db.each(
    `SELECT e.seq, e.at, e.kind, e.payload, c.data
       FROM events e LEFT JOIN contents c ON e.kind = '${kindRemember}' AND c.id = json_extract(e.payload, '$.id')
      ORDER BY e.seq`,
    [],
    (r) => {
      const seq = num(r.seq);
      const when = num(r.at);
      const kind = text(r.kind);
      const payload = text(r.payload);
      const content = r.data === null ? undefined : text(r.data);
      head = chain(head, seq, when, kind, payload, content);
      let line = `{"seq":${seq},"at":${when},"kind":${goJSON(kind)},"payload":${goCompact(payload)}`;
      if (content !== undefined) line += `,"content":${goJSON(content)}`;
      parts.push(line + `,"chain":"${head}"}\n`);
      events++;
    },
  );
  const token = db.getMeta(metaTokenHash) ?? "";
  parts.push(goJSON({ end: true, events, head, token_sha256: token === "" ? undefined : token }) + "\n");
  return { text: parts.join(""), events };
}

// orderedParams fixes the order of the parameters' keys, as the store keeps
// them in meta.
function orderedParams(p: Params): Params {
  return {
    baseStrength: p.baseStrength,
    recallBoost: p.recallBoost,
    fadeBelow: p.fadeBelow,
    archiveBelow: p.archiveBelow,
    coreImportance: p.coreImportance,
    coreFeeling: p.coreFeeling,
  };
}

// ExportEvent is one event of an export, as it is to be stored.
export interface ExportEvent {
  seq: number;
  at: number;
  kind: string;
  payload: string; // as written in the file
  content?: string; // what the memory says, for a remember event that still has it
  contentId?: string; // the memory the content belongs to
}

// ParsedExport is an export that passed every check.
export interface ParsedExport {
  logFormat: number;
  instance: string;
  exportedAt: number;
  events: ExportEvent[];
  memories: number; // remember events
  tokenHash: string; // "" when the footer holds none
  // The header's settings as JSON, unchecked; undefined when absent or null.
  settings: unknown;
}

// ---- Reading a line as Go's json.Unmarshal reads it into a struct.

// A member of a JSON object: its key and the text of its value.
type Member = [key: string, raw: string];

const isSpace = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

// skipString returns the index just past the string that starts at i.
function skipString(s: string, i: number): number {
  for (i++; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i + 1;
  }
  return i;
}

// skipValue returns the index just past the value that starts at i, in text
// already known to be valid JSON.
function skipValue(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return skipString(s, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    for (; i < s.length; i++) {
      const d = s[i];
      if (d === '"') {
        i = skipString(s, i) - 1;
      } else if (d === "{" || d === "[") {
        depth++;
      } else if (d === "}" || d === "]") {
        if (--depth === 0) return i + 1;
      }
    }
    return i;
  }
  while (i < s.length && !isSpace(s[i]) && s[i] !== "," && s[i] !== "}" && s[i] !== "]") i++;
  return i;
}

// Decoded is a line read as JSON: an object's members, null, or another
// value, which no struct can be read from.
type Decoded = { members: Member[] } | "null" | "other";

// decodeLine reads one line as JSON, or returns undefined when it is not.
function decodeLine(line: string): Decoded | undefined {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (v === null) return "null";
  if (typeof v !== "object" || Array.isArray(v)) return "other";
  const members: Member[] = [];
  let i = 0;
  const ws = () => {
    while (isSpace(line[i])) i++;
  };
  ws();
  i++; // {
  for (;;) {
    ws();
    if (line[i] === "}") break;
    const keyEnd = skipString(line, i);
    const key = JSON.parse(line.slice(i, keyEnd)) as string;
    i = keyEnd;
    ws();
    i++; // :
    ws();
    const end = skipValue(line, i);
    members.push([key, line.slice(i, end)]);
    i = end;
    ws();
    if (line[i] === ",") i++;
  }
  return { members };
}

type FieldType = "int" | "string" | "bool" | "optString" | "raw";

// Field values as Go would hold them: an int64, a string, a bool, a
// *string (undefined for nil) or a json.RawMessage.
type FieldValue = number | string | boolean | undefined;

// readField converts the text of one value to a field's type. A JSON null
// leaves the field as it was, as in Go; undefined means Go would refuse it.
function readField(type: FieldType, raw: string): { set: FieldValue } | "keep" | undefined {
  if (type === "raw") return { set: raw };
  if (raw === "null") return type === "optString" ? { set: undefined } : "keep";
  switch (type) {
    case "int": {
      // Go reads an int64 from an integer literal only: 1.0 and 1e3 are refused.
      if (!/^-?(0|[1-9][0-9]*)$/.test(raw)) return undefined;
      const n = Number(raw);
      return Number.isSafeInteger(n) ? { set: n } : undefined;
    }
    case "bool":
      return raw === "true" ? { set: true } : raw === "false" ? { set: false } : undefined;
    case "string":
    case "optString":
      return raw.startsWith('"') ? { set: JSON.parse(raw) as string } : undefined;
  }
}

// unmarshal reads members into target as json.Unmarshal reads them into a
// struct whose fields have the given JSON names and types: a key matches its
// field exactly or else regardless of case, later keys win, unknown keys are
// ignored, and a value of the wrong type is an error after the rest is read.
function unmarshal(decoded: Decoded, fields: Record<string, FieldType>, target: Record<string, FieldValue>): boolean {
  if (decoded === "null") return true;
  if (decoded === "other") return false;
  let ok = true;
  const names = Object.keys(fields);
  for (const [key, raw] of decoded.members) {
    const name = names.find((n) => n === key) ?? names.find((n) => n.toLowerCase() === key.toLowerCase());
    if (name === undefined) continue;
    const v = readField(fields[name]!, raw);
    if (v === undefined) ok = false;
    else if (v !== "keep") target[name] = v.set;
  }
  return ok;
}

const headerFields: Record<string, FieldType> = {
  ziwo_export: "int", log_format: "int", instance: "string", exported_at: "int", settings: "raw",
};
const eventFields: Record<string, FieldType> = {
  seq: "int", at: "int", kind: "string", payload: "raw", content: "optString", chain: "string",
};
const footerFields: Record<string, FieldType> = { end: "bool", events: "int", head: "string", token_sha256: "string" };

// FormatRefusal is an export whose log format this build does not take.
export class FormatRefusal extends Error {
  override name = "FormatRefusal";
}

// parseExport checks a whole export and returns what it holds. It throws
// ExportError, FormatRefusal or TooLargeError; it touches no database.
// formatMessage words the refusal of a log format other than this build's.
export function parseExport(file: string, maxEvents: number, formatMessage: (format: number) => string): ParsedExport {
  let pos = 0;
  // nextLine is Go's line(): up to and with the next newline; a last line
  // without one counts, nothing at all is the end.
  const nextLine = (): Decoded => {
    if (pos >= file.length) throw new ExportError(`${badExport}: it ends early`);
    const nl = file.indexOf("\n", pos);
    const end = nl < 0 ? file.length : nl + 1;
    const line = file.slice(pos, end);
    pos = end;
    const d = decodeLine(line);
    if (d === undefined) throw new ExportError(`${badExport}: unreadable line`);
    return d;
  };

  const head: Record<string, FieldValue> = { ziwo_export: 0, log_format: 0, instance: "", exported_at: 0, settings: "null" };
  if (!unmarshal(nextLine(), headerFields, head)) throw new ExportError(`${badExport}: unreadable line`);
  if (head.ziwo_export !== exportVersion) {
    throw new ExportError(`${badExport}: it is not a ziwo export of a kind this build reads`);
  }
  const format = head.log_format as number;
  if (format !== logFormat) throw new FormatRefusal(formatMessage(format));

  const out: ParsedExport = {
    logFormat: format,
    instance: head.instance as string,
    exportedAt: head.exported_at as number,
    events: [],
    memories: 0,
    tokenHash: "",
    settings: (JSON.parse(head.settings as string) as unknown) ?? undefined,
  };
  // One footer for the whole file, as in Go: a line read into it that is not
  // the footer can still set its fields.
  const foot: Record<string, FieldValue> = { end: false, events: 0, head: "", token_sha256: "" };
  const seqs = new Set<number>();
  const contentIds = new Set<string>();
  let prev = "";
  for (;;) {
    const d = nextLine();
    if (unmarshal(d, footerFields, foot) && foot.end === true) break;
    const e: Record<string, FieldValue> = { seq: 0, at: 0, kind: "", payload: "", content: undefined, chain: "" };
    if (!unmarshal(d, eventFields, e) || e.kind === "") throw new ExportError(`${badExport}: unreadable event`);
    const ev: ExportEvent = { seq: e.seq as number, at: e.at as number, kind: e.kind as string, payload: e.payload as string };
    const content = e.content as string | undefined;
    prev = chain(prev, ev.seq, ev.at, ev.kind, ev.payload, content);
    if (prev !== e.chain) throw new ExportError(`${badExport}: it was changed or damaged at event ${ev.seq}`);
    // What Go's insert would refuse, found before anything is written.
    if (seqs.has(ev.seq)) throw new ExportError(`${badExport}: event ${ev.seq}: UNIQUE constraint failed: events.seq`);
    seqs.add(ev.seq);
    if (out.events.length >= maxEvents) {
      throw new TooLargeError(`the export holds more than ${maxEvents} events, more than this build can bring back in one go`);
    }
    out.events.push(ev);
    if (ev.kind !== kindRemember) continue;
    out.memories++;
    if (content === undefined) continue;
    const id = payloadId(ev.payload);
    if (id === undefined) throw new ExportError(`${badExport}: event ${ev.seq}: its payload names no memory`);
    if (contentIds.has(id)) throw new ExportError(`${badExport}: event ${ev.seq}: UNIQUE constraint failed: contents.id`);
    contentIds.add(id);
    ev.content = content;
    ev.contentId = id;
  }
  if (foot.events !== out.events.length || foot.head !== prev) {
    throw new ExportError(`${badExport}: it is incomplete: it holds ${out.events.length} events and says ${foot.events}`);
  }
  out.tokenHash = foot.token_sha256 as string;
  return out;
}

// payloadId is the id a remember event's payload names, as Go reads it with
// json_extract(payload, '$.id'), when it is a string.
function payloadId(payload: string): string | undefined {
  const v: unknown = JSON.parse(payload);
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const id = (v as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

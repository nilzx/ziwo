// What may be written, checked before it reaches the store. Port of the
// limits, clean, cleanText and ParseWhen in service.go.
//
// The messages are read by the model and are part of the interface: each is
// Go's text word for word, without the "invalid input: " prefix the Go server
// strips before showing it. Lengths are counted in code points, as Go counts
// runes.

import { SourceReconstructed } from "../store/content";
import type { RememberInput, Span } from "../store/types";
import { asUTC, instantOf, UTC } from "../zone";

// Limits on what a single memory may hold. A memory is an account of a
// moment, not a transcript, so the limits are deliberately tight.
export const MaxGistRunes = 200;
export const MaxBodyRunes = 6000;
export const MaxFieldRunes = 1000;
export const MaxPointerRunes = 500;
export const MaxPeople = 16;

export const DefaultRecall = 5;
export const MaxRecall = 20;
export const MaxExpand = 10;

// Moments are the kinds of occasion worth remembering.
export const Moments = ["start", "blocked", "corrected", "breakthrough", "finished", "emotion", "other"];

// Sources say how the AI came to know what a memory holds. "reconstructed" is
// for what it lived through but writes down afterwards, from a record.
export const Sources = ["lived", "told", "inferred", SourceReconstructed];

// InvalidInput is an error the caller can fix by changing its input (Go's
// ErrInvalid). It never crosses RPC: the object hands its message back as data.
export class InvalidInput extends Error {
  override name = "InvalidInput";
}

// RememberRequest is a memory as the caller sends it, before defaults are
// filled in. A missing field is Go's zero value.
export interface RememberRequest {
  sessionId?: string;
  moment?: string;
  source?: string;
  importance?: number;
  intensity?: number;
  gist?: string;
  body?: string;
  outcome?: string;
  feeling?: string;
  lesson?: string;
  people?: string[];
  pointer?: string;
  // When it took place, in unix milliseconds; undefined is Go's zero time.
  happened?: number;
}

// runeCount counts code points, as utf8.RuneCountInString does.
export function runeCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

// clip shortens s to at most n code points.
export function clip(s: string, n: number): string {
  if (runeCount(s) <= n) return s;
  return [...s].slice(0, n).join("");
}

// trimSpace is strings.TrimSpace: it trims what unicode.IsSpace holds for,
// the White_Space property. String#trim differs from it (it trims U+FEFF and
// keeps U+0085).
const edgeSpace = /^\p{White_Space}+|\p{White_Space}+$/gu;
export function trimSpace(s: string): string {
  return s.replace(edgeSpace, "");
}

// oneLine keeps a text that is shown on one line on one line. In what
// get_context returns, a memory is told from what the server says by its
// line starting with its id; a gist or a name with a line break in it could
// pass for a line of the server's. It is applied when such a text is
// written, and again when it is shown: records written before it was, and
// those a restore brings, hold their text as it came.
export function oneLine(s: string): string {
  return s.replace(/[\n\r\v\f\u0085\u2028\u2029]+/g, " ");
}

// goQuote is Go's %q of a string (strconv.Quote).
const printable = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u;
const shortEscapes: Record<string, string> = {
  "\x07": "\\a", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\v": "\\v",
};
export function goQuote(s: string): string {
  let out = '"';
  // A lone surrogate is what JS has for invalid UTF-8; Go's JSON decoder
  // would have turned either into U+FFFD.
  for (const ch of s.toWellFormed()) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"' || ch === "\\") out += "\\" + ch;
    else if (printable.test(ch)) out += ch;
    else if (shortEscapes[ch] !== undefined) out += shortEscapes[ch];
    else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
    else if (cp < 0x10000) out += "\\u" + cp.toString(16).padStart(4, "0");
    else out += "\\U" + cp.toString(16).padStart(8, "0");
  }
  return out + '"';
}

function invalid(message: string): InvalidInput {
  return new InvalidInput(message);
}

// clean checks a memory that is about to be written as it happens, or
// reconstructed from a record, and returns what the store takes. now is the
// wall clock in unix milliseconds.
export function clean(req: RememberRequest, now: number): RememberInput {
  const sessionId = trimSpace(req.sessionId ?? "");
  if (sessionId === "") {
    throw invalid("session_id is required: call get_context first and pass the session id it returns");
  }
  const c = cleanText(req);
  if (c.body === "") throw invalid("body is required: what happened, in your own words");
  const happened = req.happened;
  if (c.source !== SourceReconstructed && happened !== undefined) {
    throw invalid(`happened_at goes with source ${goQuote(SourceReconstructed)} only: a memory written as it happens is dated now`);
  }
  if (c.source === SourceReconstructed && happened === undefined) {
    throw invalid(`happened_at is required with source ${goQuote(SourceReconstructed)}: the day it took place, as the record shows it`);
  }
  if (happened !== undefined && happened > now + 60 * 1000) throw invalid("happened_at is in the future");
  // Go's unixMilli: the zero time is 0, which the store reads as "now".
  return { ...c, sessionId, happened: happened ?? 0 };
}

// CleanText is what cleanText returns: every field filled in.
export type CleanText = Required<Omit<RememberInput, "sessionId" | "happened">>;

// cleanText checks what a memory says and fills in defaults.
export function cleanText(req: RememberRequest): CleanText {
  const gist = oneLine(trimSpace(req.gist ?? ""));
  const body = trimSpace(req.body ?? "");
  const outcome = trimSpace(req.outcome ?? "");
  const feeling = trimSpace(req.feeling ?? "");
  const lesson = trimSpace(req.lesson ?? "");
  const pointer = trimSpace(req.pointer ?? "");

  if (gist === "") throw invalid("gist is required: one sentence saying what happened");
  let n = runeCount(gist);
  if (n > MaxGistRunes) throw invalid(`gist is ${n} characters, the limit is ${MaxGistRunes}: keep it to one sentence`);
  n = runeCount(body);
  if (n > MaxBodyRunes) {
    throw invalid(`body is ${n} characters, the limit is ${MaxBodyRunes}: a memory is an account of what you lived through, not a transcript or project notes`);
  }
  // Go walks a map here, so when several fields are too long it names any
  // one of them; this names the first in this order.
  for (const [name, v] of [["outcome", outcome], ["feeling", feeling], ["lesson", lesson]] as const) {
    n = runeCount(v);
    if (n > MaxFieldRunes) throw invalid(`${name} is ${n} characters, the limit is ${MaxFieldRunes}`);
  }
  n = runeCount(pointer);
  if (n > MaxPointerRunes) throw invalid(`pointer is ${n} characters, the limit is ${MaxPointerRunes}: give a location, not the content`);

  const moment = req.moment === undefined || req.moment === "" ? "other" : req.moment;
  if (!Moments.includes(moment)) throw invalid(`moment must be one of ${Moments.join(", ")}`);
  const source = req.source === undefined || req.source === "" ? "lived" : req.source;
  if (!Sources.includes(source)) throw invalid(`source must be one of ${Sources.join(", ")}`);
  let importance = req.importance ?? 0;
  if (importance === 0) importance = 0.5;
  if (importance < 0 || importance > 1) throw invalid("importance must be between 0 and 1");
  const intensity = req.intensity ?? 0;
  if (intensity < 0 || intensity > 1) throw invalid("feeling_intensity must be between 0 and 1");
  if (intensity > 0 && feeling === "") {
    throw invalid("feeling_intensity needs a feeling: say what registered, or leave both out");
  }

  const people: string[] = [];
  for (const raw of req.people ?? []) {
    const p = clip(trimSpace(raw), 80);
    if (p !== "" && !people.includes(p)) people.push(p);
  }
  if (people.length > MaxPeople) throw invalid(`at most ${MaxPeople} people per memory`);

  return { moment, source, importance, intensity, gist, body, outcome, feeling, lesson, people, pointer };
}

// parseWhen reads a date, or a date and time, as a model would write it, and
// returns it in unix milliseconds. A time without a zone is read as the wall
// clock of zone, UTC when none is given; one with a zone or Z as written. It
// accepts what Go's time.Parse accepts for the same five layouts: a one-digit
// hour, a fraction of a second after the seconds, one or more spaces where
// the layout has one. undefined is Go's zero time (0001-01-01T00:00:00Z),
// which the Go build then treats as no date at all.
export function parseWhen(s: string, zone: string = UTC): number | undefined {
  s = trimSpace(s);
  for (const layout of whenLayouts) {
    const m = layout.exec(s);
    if (m === null) continue;
    const t = whenOf(m.groups ?? {}, zone);
    if (t !== null) return t;
  }
  throw invalid(`cannot read ${goQuote(s)} as a date: write it like 2026-03-14 or 2026-03-14T09:30:00Z`);
}

const date = String.raw`(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})`;
const clockSec = String.raw`(?<h>\d{1,2}):(?<mi>\d{2}):(?<s>\d{2})(?:[.,](?<f>\d+))?`;
// time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02 15:04", time.DateOnly.
const whenLayouts = [
  new RegExp(String.raw`^${date}T${clockSec}(?<z>Z|[+-]\d{2}:\d{2})$`),
  new RegExp(String.raw`^${date}T${clockSec}$`),
  new RegExp(String.raw`^${date} +${clockSec}$`),
  new RegExp(String.raw`^${date} +(?<h>\d{1,2}):(?<mi>\d{2})$`),
  new RegExp(String.raw`^${date}$`),
];

// The zero time of Go, in unix milliseconds.
const goZeroTime = -62135596800000;

// MaxQueryParts is how many parts of a query recall searches on their own.
export const MaxQueryParts = 4;

// Where a query that names several things is split: list punctuation, in
// either width, and line breaks. A slash is left alone (dates, addresses),
// and so is a comma between two digits (1,000).
const partBreak = /[、，;；|\n\r\v\f\u0085\u2028\u2029]|(?<!\d),|,(?!\d)/u;

// queryParts splits a query into the things it names, trimmed, empty ones
// dropped. Past MaxQueryParts, the last part kept holds the rest as written
// between them, so that what they name is still searched apart from the
// first ones. A query that names one thing comes back as one part.
export function queryParts(query: string): string[] {
  const parts: string[] = [];
  let rest = query;
  for (;;) {
    const m = partBreak.exec(rest);
    if (parts.length === MaxQueryParts - 1 || m === null) {
      const last = trimSpace(rest);
      // The rest, once cut, may begin or end with a break of its own.
      const tail = parts.length === MaxQueryParts - 1 ? trimBreaks(last) : last;
      if (tail !== "") parts.push(tail);
      return parts;
    }
    const part = trimSpace(rest.slice(0, m.index));
    if (part !== "") parts.push(part);
    rest = rest.slice(m.index + m[0].length);
  }
}

const edgeBreaks = new RegExp(`^(?:${partBreak.source}|\\p{White_Space})+|(?:${partBreak.source}|\\p{White_Space})+$`, "gu");
function trimBreaks(s: string): string {
  return s.replace(edgeBreaks, "");
}

const dateAlone = /^\d{4}-\d{2}-\d{2}$/;

// parseSpan reads the since and until of a recall in zone, as parseWhen
// reads happened_at. A date alone is the whole day: since from its start,
// until to its end. undefined when neither is given; blank counts as not
// given.
export function parseSpan(since: string | undefined, until: string | undefined, zone: string = UTC): Span | undefined {
  const from = spanEnd("since", since, zone, false);
  const to = spanEnd("until", until, zone, true);
  if (from === undefined && to === undefined) return undefined;
  if (from !== undefined && to !== undefined && from > to) {
    throw invalid("since is after until: give a since that comes before until, or leave one out");
  }
  return { ...(from === undefined ? {} : { since: from }), ...(to === undefined ? {} : { until: to }) };
}

function spanEnd(field: string, s: string | undefined, zone: string, end: boolean): number | undefined {
  if (s === undefined) return undefined;
  s = trimSpace(s);
  if (s === "") return undefined;
  let at: number | undefined;
  try {
    at = parseWhen(s, zone);
  } catch (err) {
    if (err instanceof InvalidInput) {
      throw invalid(`cannot read ${field} ${goQuote(s)} as a date: write it like 2026-03-14 or 2026-03-14T09:30:00Z`);
    }
    throw err;
  }
  if (!end || !dateAlone.test(s)) return at ?? goZeroTime;
  // To the end of the day: the start of the next one, less a millisecond.
  const [y, mo, d] = s.split("-").map(Number) as [number, number, number];
  const next = new Date(asUTC({ year: y, month: mo, day: d + 1, hour: 0, minute: 0, second: 0, ms: 0 }));
  const wall = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0, second: 0, ms: 0 };
  return (zone === UTC ? asUTC(wall) : instantOf(wall, zone)) - 1;
}

function daysIn(month: number, year: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// whenOf applies Go's range checks and returns the instant, or null when a
// field is out of range. undefined is the zero time.
function whenOf(g: Record<string, string | undefined>, zone: string): number | undefined | null {
  const int = (x: string | undefined): number => (x === undefined ? 0 : Number(x));
  const year = int(g.y), month = int(g.mo), day = int(g.d);
  const hour = int(g.h), minute = int(g.mi), second = int(g.s);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  if (day < 1 || day > daysIn(month, year)) return null;
  let offset = 0; // seconds east of UTC
  if (g.z !== undefined && g.z !== "Z") {
    const zh = Number(g.z.slice(1, 3)), zm = Number(g.z.slice(4, 6));
    // Go allows 24 hours and 60 minutes here.
    if (zh > 24 || zm > 60) return null;
    offset = (zh * 60 + zm) * 60 * (g.z[0] === "-" ? -1 : 1);
  }
  // Go keeps at most nine digits of the fraction; milliseconds are the first three.
  const frac = (g.f ?? "").slice(0, 9).padEnd(9, "0");
  const ms = Number(frac.slice(0, 3));
  const finer = Number(frac.slice(3));
  const wall = { year, month, day, hour, minute, second, ms };
  // Without a zone of its own, the time is what a clock in zone showed.
  const at = g.z === undefined && zone !== UTC ? instantOf(wall, zone) : asUTC(wall) - offset * 1000;
  if (at === goZeroTime && finer === 0) return undefined;
  return at;
}

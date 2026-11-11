// Kinds of event in the log and their payloads. The JSON field names, their
// order and which are left out when empty are those of the event structs in
// store.go and export.go: a later stage imports logs the Go build wrote.

import { bool, goJSON, int, num, parseObject, str, strs } from "./json";

export const kindSession = "session"; // a conversation loaded the memory
export const kindRemember = "remember"; // a memory was written
export const kindRecall = "recall"; // memories were listed by a search
export const kindExpand = "expand"; // memories were read in full
export const kindAmend = "amend"; // a memory's standing or weight was changed, or a preference set
export const kindErase = "erase"; // what a memory says was deleted for good
export const kindReflect = "reflect"; // a round of reflection was written back
export const kindRestore = "restore"; // the memory was brought back from an export

export interface SessionEvent {
  id: string;
  model: string;
  client: string;
  // The IANA time zone the model reported for the person it talks with.
  // New on this platform; absent when none was reported.
  tz?: string;
}

// RememberEvent records that a memory was written. What the memory says is in
// the contents table, under the same id.
export interface RememberEvent {
  id: string;
  session: string;
  kind: string; // empty means a fragment
  moment: string;
  source: string;
  importance: number;
  intensity: number;
  hash: string; // SHA-256 of the stored content
  corrects: string; // id of the memory this one replaces
  happened: number; // when it took place, if not when it was written; 0 otherwise
  from: string[]; // ids of the memories it is built on
  ref: string; // self: the statement it revises; reading: the memory it reads
  milestone: boolean;
  // Impression: the ids of the impressions it takes the place of, worked out
  // when it was written. New on this platform; absent in logs the Go build
  // wrote, and when there are none. Absent, the impressions it replaces are
  // found by what they are about, as Go does.
  replaces?: string[];
}

export interface RecallEvent {
  session: string;
  query: string;
  ids: string[];
  clock: number; // the experience clock when they were listed; 0 when not given
}

export interface ExpandEvent {
  session: string;
  ids: string[];
  clock: number; // the experience clock when they were read; 0 when not given
}

// AmendEvent records a change to a memory's standing or weight, or a
// preference set or retired. Field order and omissions are amendEvent's.
export interface AmendEvent {
  session: string;
  action: string;
  id: string; // a memory; a preference for prefer and unprefer
  importance: number; // for reweigh; written even when 0, as Go does
  text: string; // the preference, for prefer
  reason: string; // why it was asked for
}

// EraseEvent records that what a memory says was deleted for good.
export interface EraseEvent {
  session: string;
  id: string;
  reason: string;
}

// ReflectEvent records a round of reflection written back.
export interface ReflectEvent {
  session: string;
  batch: string;
  passed: string[]; // fragments looked at and left as they are
  wrote: string[]; // ids of the memories written back
}

export interface RestoreEvent {
  from: string; // instance the export was made from
  exportedAt: number;
  events: number;
}

const omit = (s: string): string | undefined => (s === "" ? undefined : s);
const omitNum = (n: number): number | undefined => (n === 0 ? undefined : n);

export function encodeSession(e: SessionEvent): string {
  return goJSON({ id: e.id, model: omit(e.model), client: omit(e.client), tz: omit(e.tz ?? "") });
}

export function encodeRemember(e: RememberEvent): string {
  return goJSON({
    id: e.id,
    session: e.session,
    kind: omit(e.kind),
    moment: e.moment,
    source: e.source,
    importance: e.importance,
    intensity: omitNum(e.intensity),
    hash: e.hash,
    corrects: omit(e.corrects),
    happened: omitNum(e.happened),
    from: e.from.length > 0 ? e.from : undefined,
    ref: omit(e.ref),
    milestone: e.milestone ? true : undefined,
    replaces: e.replaces !== undefined && e.replaces.length > 0 ? e.replaces : undefined,
  });
}

export function encodeAmend(e: AmendEvent): string {
  return goJSON({
    session: e.session,
    action: e.action,
    id: e.id,
    importance: e.importance,
    text: omit(e.text),
    reason: omit(e.reason),
  });
}

export function encodeErase(e: EraseEvent): string {
  return goJSON({ session: e.session, id: e.id, reason: omit(e.reason) });
}

export function encodeReflect(e: ReflectEvent): string {
  return goJSON({
    session: e.session,
    batch: e.batch,
    passed: e.passed.length > 0 ? e.passed : undefined,
    wrote: e.wrote.length > 0 ? e.wrote : undefined,
  });
}

export function encodeRecall(e: RecallEvent): string {
  return goJSON({ session: omit(e.session), query: e.query, ids: e.ids, clock: omitNum(e.clock) });
}

export function encodeExpand(e: ExpandEvent): string {
  return goJSON({ session: omit(e.session), ids: e.ids, clock: omitNum(e.clock) });
}

export function decodeSession(payload: string): SessionEvent {
  const o = parseObject(payload, kindSession);
  return { id: str(o, "id"), model: str(o, "model"), client: str(o, "client"), tz: str(o, "tz") };
}

export function decodeRemember(payload: string): RememberEvent {
  const o = parseObject(payload, kindRemember);
  return {
    id: str(o, "id"),
    session: str(o, "session"),
    kind: str(o, "kind"),
    moment: str(o, "moment"),
    source: str(o, "source"),
    importance: num(o, "importance"),
    intensity: num(o, "intensity"),
    hash: str(o, "hash"),
    corrects: str(o, "corrects"),
    happened: int(o, "happened"),
    from: strs(o, "from"),
    ref: str(o, "ref"),
    milestone: bool(o, "milestone"),
    // Absent and null both mean the field was not written.
    replaces: o.replaces === undefined || o.replaces === null ? undefined : strs(o, "replaces"),
  };
}

export function decodeAmend(payload: string): AmendEvent {
  const o = parseObject(payload, kindAmend);
  return {
    session: str(o, "session"),
    action: str(o, "action"),
    id: str(o, "id"),
    importance: num(o, "importance"),
    text: str(o, "text"),
    reason: str(o, "reason"),
  };
}

export function decodeErase(payload: string): EraseEvent {
  const o = parseObject(payload, kindErase);
  return { session: str(o, "session"), id: str(o, "id"), reason: str(o, "reason") };
}

export function decodeReflect(payload: string): ReflectEvent {
  const o = parseObject(payload, kindReflect);
  return { session: str(o, "session"), batch: str(o, "batch"), passed: strs(o, "passed"), wrote: strs(o, "wrote") };
}

export function decodeRecall(payload: string): RecallEvent {
  const o = parseObject(payload, kindRecall);
  return { session: str(o, "session"), query: str(o, "query"), ids: strs(o, "ids"), clock: int(o, "clock") };
}

export function decodeExpand(payload: string): ExpandEvent {
  const o = parseObject(payload, kindExpand);
  return { session: str(o, "session"), ids: strs(o, "ids"), clock: int(o, "clock") };
}

// encodeRestore writes the payload Go's Import appends (restoreEvent in
// export.go): from is left out when the export named no instance.
export function encodeRestore(e: RestoreEvent): string {
  return goJSON({ from: omit(e.from), exported_at: e.exportedAt, events: e.events });
}

export function decodeRestore(payload: string): RestoreEvent {
  const o = parseObject(payload, kindRestore);
  return { from: str(o, "from"), exportedAt: int(o, "exported_at"), events: int(o, "events") };
}

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

export interface RestoreEvent {
  from: string; // instance the export was made from
  exportedAt: number;
  events: number;
}

const omit = (s: string): string | undefined => (s === "" ? undefined : s);
const omitNum = (n: number): number | undefined => (n === 0 ? undefined : n);

export function encodeSession(e: SessionEvent): string {
  return goJSON({ id: e.id, model: omit(e.model), client: omit(e.client) });
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
  return { id: str(o, "id"), model: str(o, "model"), client: str(o, "client") };
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
  };
}

export function decodeRecall(payload: string): RecallEvent {
  const o = parseObject(payload, kindRecall);
  return { session: str(o, "session"), query: str(o, "query"), ids: strs(o, "ids"), clock: int(o, "clock") };
}

export function decodeExpand(payload: string): ExpandEvent {
  const o = parseObject(payload, kindExpand);
  return { session: str(o, "session"), ids: strs(o, "ids"), clock: int(o, "clock") };
}

export function decodeRestore(payload: string): RestoreEvent {
  const o = parseObject(payload, kindRestore);
  return { from: str(o, "from"), exportedAt: int(o, "exported_at"), events: int(o, "events") };
}

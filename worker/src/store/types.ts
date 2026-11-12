// The shapes the store hands out and takes in. Ported from the types in
// store.go. Times are unix milliseconds.

// Session is one conversation, as far as the memory can tell.
export interface Session {
  id: string;
  startedAt: number;
  lastActiveAt: number; // the last time it loaded, wrote or recalled
  model: string;
  client: string;
  tz: string; // the IANA time zone the model reported; '' when none
}

// CarrierNote says whether the model starting a session is new to this memory.
export interface CarrierNote {
  // True when this model has never loaded the memory before and some other
  // model has.
  first: boolean;
  // Other models that have loaded it, most recent first, at most three.
  earlier: string[];
}

// Memory is one remembered moment.
export interface Memory {
  n: number;
  id: string;
  createdAt: number; // when it happened
  writtenAt: number; // when it was written; later, for what was reconstructed
  sessionId: string;
  model: string; // carrier at the time of writing
  client: string;
  moment: string;
  source: string;
  importance: number;
  intensity: number; // how strongly it registered, 0 to 1
  gist: string;
  body: string;
  outcome: string;
  feeling: string;
  lesson: string;
  people: string[];
  pointer: string;
  lastRecalledAt: number;
  recallCount: number; // times listed or read

  kind: string; // one of the kinds in content.ts
  about: string; // impression: who or what it is about
  context: string; // self: the situation the statement holds in
  ref: string; // self: the statement it revises; reading: the memory it reads
  milestone: boolean;
  pending: boolean; // a fragment that reflect has not dealt with yet
  state: string; // "" while it stands, else one of the states in content.ts
  stateBy: string; // id of the memory that replaced or absorbed it
  retracted: boolean; // set aside on request; not recalled until restored
  pinned: boolean; // kept as core on request
  corrects: string; // id of the memory this one corrects

  // Forgetting; see decay.ts. The clock counts memories written.
  ord: number; // 1 for the first memory written, 2 for the next
  touchedOrd: number; // clock when it last came to mind: listed or read
  readOrd: number; // clock when it was last read in full
  core: boolean; // never fades
  strength: number; // counted in memories
  fadeAt: number; // clock value from which only the gist is findable; 0 for core
  archiveAt: number; // clock value from which it leaves ordinary search; 0 for core
}

// isLive reports whether the memory stands: it has not been replaced by a
// correction, erased, or set aside.
export function isLive(m: Memory): boolean {
  return m.state === "" && !m.retracted;
}

// RememberInput is what a new memory is made from. The caller validates it.
export interface RememberInput {
  sessionId: string;
  moment: string;
  source: string;
  importance: number;
  intensity?: number;
  gist: string;
  body: string;
  outcome?: string;
  feeling?: string;
  lesson?: string;
  people?: string[];
  pointer?: string;
  // When it took place, for a memory reconstructed afterwards. Absent or 0
  // means when it was written.
  happened?: number;
}

// RecallNote records that some memories came to mind.
export interface RecallNote {
  at: number;
  session?: string;
  // True when the memories were read in full, false when a search listed them.
  read?: boolean;
  query?: string; // the search, when read is false
  ids: string[];
  // The experience clock when they came to mind. Absent or 0 means the clock
  // when the note is logged. A clock later than that is taken as that.
  clock?: number;
}

// Span is the time a recall is kept to, by when its memories took place,
// both ends included, in unix milliseconds. An end left out is open.
export interface Span {
  since?: number;
  until?: number;
}

// TextHit is a memory matched by keyword.
export interface TextHit {
  n: number;
  // The bm25 match strength, larger for a better match. Comparable between
  // hits of one search only.
  score: number;
}

// Preference is a standing rule about what to remember, set in conversation.
export interface Preference {
  id: string;
  createdAt: number;
  text: string;
}

// RestoreNote says that a memory was brought back from an export.
export interface RestoreNote {
  at: number; // when it was brought back
  exportedAt: number; // when the export was made
}

// LogStats describes a memory from its event log alone.
export interface LogStats {
  memories: number; // memories ever written
  events: number;
  lastEventAt: number | null; // null when the log is empty
  hasToken: boolean;
}

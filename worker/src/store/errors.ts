// What the store refuses, as classes the service tells apart. Ports of the
// error values in store.go, amend.go and reflect.go. They never cross RPC:
// the service turns each into a message for the model.

// NoSessionError is thrown when a write names a session that does not exist.
export class NoSessionError extends Error {
  override name = "NoSessionError";
  constructor(readonly sessionId: string) {
    super(`no such session: ${JSON.stringify(sessionId)}`);
  }
}

// NoMemoryError is thrown for an id that names no memory.
export class NoMemoryError extends Error {
  override name = "NoMemoryError";
  constructor(readonly id: string) {
    super(`no such memory: ${JSON.stringify(id)}`);
  }
}

// ErasedError is thrown when a memory's content is gone and the request
// needs it.
export class ErasedError extends Error {
  override name = "ErasedError";
  constructor() {
    super("the memory has been erased");
  }
}

// SupersededError is thrown when a correction has already replaced the
// memory. by is the id of what replaced it.
export class SupersededError extends Error {
  override name = "SupersededError";
  constructor(readonly by: string) {
    super(`the memory has been replaced by a correction: ${by}`);
  }
}

// NoPreferenceError is thrown for an id that names no preference in force.
export class NoPreferenceError extends Error {
  override name = "NoPreferenceError";
  constructor(readonly id: string) {
    super(`no such preference: ${JSON.stringify(id)}`);
  }
}

// TooManyPreferencesError is thrown when no more preferences fit.
export class TooManyPreferencesError extends Error {
  override name = "TooManyPreferencesError";
  constructor() {
    super("too many preferences");
  }
}

// ReflectBusyError is thrown when another session holds the round of
// reflection. Two sessions reflecting at once would put the same fragments
// together twice. until is when that round runs out, in unix milliseconds.
export class ReflectBusyError extends Error {
  override name = "ReflectBusyError";
  constructor(readonly until: number) {
    super("another conversation is reflecting");
  }
}

// NoBatchError is thrown when the batch being written back is not the one
// that is open.
export class NoBatchError extends Error {
  override name = "NoBatchError";
  constructor() {
    super("that batch is not open");
  }
}

// EntryError says which entry of a write-back cannot be written, and why, in
// words meant for whoever wrote it. index counts from 0; the message counts
// from 1, as Go's Error() does.
export class EntryError extends Error {
  override name = "EntryError";
  constructor(
    readonly msg: string,
    readonly index = 0,
  ) {
    super(`entry ${index + 1}: ${msg}`);
  }
}

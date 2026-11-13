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
    // False when msg names its entries itself.
    readonly prefixed = true,
  ) {
    super(prefixed ? `entry ${index + 1}: ${msg}` : msg);
  }
}

// SubjectError is thrown when a subject given by name or id cannot be used:
// the name has no letter or digit, or the id names no subject. value is as it
// was given.
export class SubjectError extends Error {
  override name = "SubjectError";
  constructor(
    readonly value: string,
    readonly reason: "no-letter" | "no-subject",
  ) {
    super(reason === "no-letter" ? "a subject's name needs a letter or a digit" : "no such subject");
  }
}

// IsSubjectError is thrown when an amendment names a subject item: a subject
// is changed in a round of reflection, and erased with erase.
export class IsSubjectError extends Error {
  override name = "IsSubjectError";
  constructor(readonly id: string) {
    super("the memory is a subject");
  }
}

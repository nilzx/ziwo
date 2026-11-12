// Amending and reflecting, as the service offers them. Port of
// internal/memory/amend.go without the vector index and the embedder: where
// Go wakes the embedder, the object sets its alarm after the call, and where
// Go drops a memory from its index, the memory stays there until that alarm
// sweeps it; recall leaves it out meanwhile. Erasing drops the vector at once
// (Store.erase).
//
// erase is a call of its own here, not an action of amend.
//
// The messages are read by the model: each is Go's text word for word,
// without the "invalid input: " prefix the Go server strips.

import { KindEpisode, KindFragment, KindImpression, KindLesson, KindReading, KindSelf, StateErased } from "../store/content";
import {
  EntryError,
  ErasedError,
  NoBatchError,
  NoMemoryError,
  NoPreferenceError,
  NoSessionError,
  ReflectBusyError,
  SupersededError,
  TooManyPreferencesError,
} from "../store/errors";
import type { Entry } from "../store/reflect";
import type { Store } from "../store/store";
import type { Memory } from "../store/types";
import { clip, cleanText, goQuote, InvalidInput, oneLine, runeCount, trimSpace } from "./clean";

// Limits on amending and reflecting.
export const MaxReasonRunes = 300;
export const MaxPreferenceRunes = 300;
export const MaxPreferences = 30;
export const MaxContextRunes = 200;
export const MaxEntries = 20;
export const MaxFrom = 20;

export const DefaultReflect = 12;
export const MaxReflect = 20;

// reflectHold is how long a round of reflection keeps other sessions from
// starting one: Go's default of Config.ReflectHold. Not settable yet.
export const reflectHold = 15 * 60 * 1000;

// AmendActions are the things amend can do. Go's list has erase among them,
// between correct and prefer; here erase is a call of its own.
export const AmendActions = ["retract", "restore", "pin", "unpin", "reweigh", "correct", "prefer", "unprefer"];

// EntryKinds are the kinds of memory a round of reflection can write back.
export const EntryKinds = [KindEpisode, KindLesson, KindImpression, KindSelf, KindReading];

function invalid(message: string): InvalidInput {
  return new InvalidInput(message);
}

// AmendRequest asks for a change to how something is remembered. A missing
// field is Go's zero value.
export interface AmendRequest {
  sessionId?: string;
  action?: string; // one of AmendActions
  id?: string; // the memory, or the preference for unprefer
  reason?: string; // why, in the words of whoever asked
  importance?: number;
  text?: string; // prefer: the rule
  // correct: what replaces the old account. Fields left empty keep what the
  // old memory said.
  gist?: string;
  body?: string;
  outcome?: string;
  lesson?: string;
}

// The fields of a request after trimming, as amendError reads them.
interface Asked {
  sessionId: string;
  id: string;
}

// amend carries out one amendment and returns a sentence saying what was done.
export function amend(st: Store, now: number, req: AmendRequest): string {
  const sessionId = trimSpace(req.sessionId ?? "");
  const action = trimSpace(req.action ?? "");
  const id = trimSpace(req.id ?? "");
  const reason = trimSpace(req.reason ?? "");
  const text = trimSpace(req.text ?? "");
  if (sessionId === "") throw invalid("session_id is required: call get_context first and pass the session id it returns");
  if (action === "erase") throw invalid("erase is a tool of its own: call erase with the id of the memory");
  if (!AmendActions.includes(action)) throw invalid(`action must be one of ${AmendActions.join(", ")}`);
  const n = runeCount(reason);
  if (n > MaxReasonRunes) throw invalid(`reason is ${n} characters, the limit is ${MaxReasonRunes}`);
  if (id === "" && action !== "prefer") throw invalid(`id is required for ${action}`);
  const asked = { sessionId, id };

  try {
    switch (action) {
      case "prefer": {
        if (text === "") throw invalid("text is required for prefer: the rule, in one or two sentences");
        const tn = runeCount(text);
        if (tn > MaxPreferenceRunes) {
          throw invalid(`text is ${tn} characters, the limit is ${MaxPreferenceRunes}: a preference is a short rule`);
        }
        const pid = st.addPreference(now, sessionId, oneLine(text), MaxPreferences);
        return "preference saved as " + pid + "; get_context will show it from now on";
      }
      case "unprefer":
        st.retirePreference(now, sessionId, id, reason);
        return "preference " + id + " dropped";
      case "reweigh": {
        const importance = req.importance ?? 0;
        if (!(importance > 0 && importance <= 1)) {
          throw invalid("importance is required for reweigh, above 0 and at most 1");
        }
        st.amend(now, sessionId, action, id, importance, reason);
        return `importance of ${id} is now ${goG(importance, 2)}`;
      }
      case "correct":
        return correct(st, now, { ...req, sessionId, id });
      default: {
        // retract, restore, pin, unpin
        st.amend(now, sessionId, action, id, 0, reason);
        const said: Record<string, string> = {
          retract: `retracted ${id}: it stays in the record and will not be recalled. restore undoes this`,
          restore: `restored ${id}: it can be recalled again`,
          pin: `pinned ${id}: it will not fade`,
          unpin: `unpinned ${id}: it fades like any other memory from here on`,
        };
        return said[action]!;
      }
    }
  } catch (err) {
    throw amendError(err, asked);
  }
}

// EraseRequest asks for what a memory says to be deleted for good.
export interface EraseRequest {
  sessionId?: string;
  id?: string;
  reason?: string;
}

// erase deletes what a memory says, for good, with the checks Go's amend
// makes for the action erase, and returns Go's sentence for it.
export function erase(st: Store, now: number, req: EraseRequest): string {
  const sessionId = trimSpace(req.sessionId ?? "");
  const id = trimSpace(req.id ?? "");
  const reason = trimSpace(req.reason ?? "");
  if (sessionId === "") throw invalid("session_id is required: call get_context first and pass the session id it returns");
  const n = runeCount(reason);
  if (n > MaxReasonRunes) throw invalid(`reason is ${n} characters, the limit is ${MaxReasonRunes}`);
  if (id === "") throw invalid("id is required for erase");
  try {
    st.erase(now, sessionId, id, reason);
  } catch (err) {
    throw amendError(err, { sessionId, id });
  }
  return "erased " + id + ": what it said is gone for good. The record keeps only that it existed and that it was erased";
}

// correct writes a memory that takes the place of an old one. What the
// request leaves empty is carried over, and the new memory keeps the time the
// thing happened. req carries the trimmed session and id.
function correct(st: Store, now: number, req: AmendRequest & Asked): string {
  const gist = req.gist ?? "", body = req.body ?? "", outcome = req.outcome ?? "", lesson = req.lesson ?? "";
  if (trimSpace(gist + body + outcome + lesson) === "") {
    throw invalid("correct needs what to say instead: give gist, body, outcome or lesson, whichever was wrong");
  }
  const old = st.get([req.id])[0];
  if (old === undefined) throw new NoMemoryError(req.id);
  if (old.state === StateErased) throw new ErasedError();
  if (old.kind !== KindFragment && old.kind !== KindEpisode && old.kind !== KindLesson) {
    throw invalid(`${req.id} is a ${old.kind}: only fragments, episodes and lessons are corrected this way`);
  }
  const instead = (to: string, from: string): string => (trimSpace(from) !== "" ? from : to);
  const c = cleanText({
    moment: old.moment, source: old.source, importance: old.importance, intensity: old.intensity,
    gist: instead(old.gist, gist), body: instead(old.body, body), outcome: instead(old.outcome, outcome),
    feeling: old.feeling, lesson: instead(old.lesson, lesson), people: old.people, pointer: old.pointer,
  });
  const id = st.correct(now, req.id, { ...c, sessionId: req.sessionId, happened: old.createdAt });
  return `corrected: ${id} now stands in place of ${req.id}, which stays in the record marked as replaced`;
}

// amendError turns what the store refused into a message for the model.
// Anything it does not know is handed back as it is.
function amendError(err: unknown, req: Asked): unknown {
  if (err instanceof InvalidInput) return err;
  if (err instanceof NoSessionError) {
    return invalid(`unknown session_id ${goQuote(req.sessionId)}: call get_context and pass the session id it returns`);
  }
  if (err instanceof NoMemoryError) return invalid(`no memory with id ${goQuote(req.id)}`);
  if (err instanceof ErasedError) return invalid(`${req.id} has been erased; there is nothing left to amend`);
  if (err instanceof SupersededError) return invalid(`${req.id} has been replaced by a correction (${err.by}): amend that one`);
  if (err instanceof NoPreferenceError) return invalid(`no preference in force with id ${goQuote(req.id)}`);
  if (err instanceof TooManyPreferencesError) {
    return invalid(`there are already ${MaxPreferences} preferences in force: drop one with unprefer, or fold this into an existing one`);
  }
  return err;
}

// ReflectView is what a round of reflection is given to work on.
export interface ReflectView {
  batch: string; // empty when there is nothing to reflect on
  fragments: Memory[]; // in full, those nearest to fading first
  selves: Memory[]; // the statements about oneself that stand
  impressions: Memory[]; // current impressions of the people in the fragments
  remaining: number; // fragments still waiting beyond this batch
}

// beginReflect opens a round of reflection for the session and hands it a
// batch of fragments. Only one round is open at a time.
export function beginReflect(st: Store, now: number, session: string, limit: number): ReflectView {
  session = trimSpace(session);
  if (session === "") throw invalid("session_id is required: call get_context first and pass the session id it returns");
  if (limit <= 0) limit = DefaultReflect;
  else if (limit > MaxReflect) limit = MaxReflect;
  const view: ReflectView = { batch: "", fragments: st.pending(limit), selves: [], impressions: [], remaining: 0 };
  if (view.fragments.length === 0) {
    if (st.session(session) === undefined) throw amendError(new NoSessionError(session), { sessionId: session, id: "" });
    return view;
  }
  try {
    view.batch = st.beginReflect(now, session, reflectHold);
  } catch (err) {
    if (err instanceof ReflectBusyError) {
      throw invalid(
        `another conversation is reflecting right now, so that the same fragments are not put together twice. ` +
          `Its round runs out in ${Math.ceil((err.until - now) / 60000)} min at the latest; try again then`,
      );
    }
    throw amendError(err, { sessionId: session, id: "" });
  }
  view.selves = st.selves();
  const names: string[] = [];
  for (const f of view.fragments) for (const p of f.people) if (!names.includes(p)) names.push(p);
  view.impressions = st.impressions(names);
  view.remaining = st.pendingCount() - view.fragments.length;
  return view;
}

// EntryRequest is an entry as the caller sends it. A missing field is Go's
// zero value.
export type EntryRequest = Partial<Entry>;

// finishReflect writes a round of reflection back and returns the ids of the
// memories it made, in the order of the entries. pass names fragments that
// were looked at and left as they are.
export function finishReflect(
  st: Store, now: number, session: string, batch: string, entries: EntryRequest[], pass: string[],
): string[] {
  session = trimSpace(session);
  batch = trimSpace(batch);
  if (session === "") throw invalid("session_id is required: call get_context first and pass the session id it returns");
  if (entries.length === 0 && pass.length === 0) {
    throw invalid("nothing to write back: give entries, or pass the fragments you are leaving as they are");
  }
  if (entries.length > MaxEntries) throw invalid(`at most ${MaxEntries} entries per round`);
  const clean = entries.map((e, i) => {
    try {
      return cleanEntry(e);
    } catch (err) {
      if (err instanceof InvalidInput) throw invalid(`${err.message} (entry ${i + 1})`);
      throw err;
    }
  });
  try {
    return st.finishReflect(now, session, batch, clean, tidyIDs(pass));
  } catch (err) {
    if (err instanceof EntryError) throw invalid(`${err.message}. Nothing was written`);
    if (err instanceof NoBatchError) {
      throw invalid(
        `batch ${goQuote(batch)} is not open: it was already written back, or its round ran out and another conversation started one. ` +
          `Nothing was written. Call reflect without a batch to start again`,
      );
    }
    throw amendError(err, { sessionId: session, id: "" });
  }
}

// tidyIDs trims ids and drops the empty and the repeated ones.
export function tidyIDs(ids: string[]): string[] {
  const out: string[] = [];
  for (let id of ids) {
    id = trimSpace(id);
    if (id !== "" && !out.includes(id)) out.push(id);
  }
  return out;
}

// cleanEntry checks what an entry says and fills in defaults. Whether what it
// rests on allows it is checked by the store, against the memory as it stands.
export function cleanEntry(req: EntryRequest): Entry {
  const kind = trimSpace(req.kind ?? "");
  let ref = trimSpace(req.ref ?? "");
  let about = clip(oneLine(trimSpace(req.about ?? "")), 80);
  let context = oneLine(trimSpace(req.context ?? ""));
  if (!EntryKinds.includes(kind)) throw invalid(`kind must be one of ${EntryKinds.join(", ")}`);
  const c = cleanText({
    gist: req.gist, body: req.body, outcome: req.outcome, feeling: req.feeling, lesson: req.lesson,
    people: req.people, pointer: req.pointer, importance: req.importance, intensity: req.intensity,
    moment: "other", source: "lived",
  });
  if ((kind === KindEpisode || kind === KindLesson) && c.body === "") throw invalid(`body is required for ${kind}`);
  const n = runeCount(context);
  if (n > MaxContextRunes) {
    throw invalid(`context is ${n} characters, the limit is ${MaxContextRunes}: name the situation, do not describe it`);
  }
  const from = tidyIDs(req.from ?? []);
  if (from.length > MaxFrom) throw invalid(`at most ${MaxFrom} ids in from`);
  if (kind === KindImpression && about === "") throw invalid("about is required for an impression: the person or thing, by name");
  if (kind === KindReading && ref === "") throw invalid("ref is required for a reading: the id of the memory it is about");
  if (kind !== KindImpression) about = "";
  if (kind !== KindSelf) context = "";
  if (kind !== KindSelf && kind !== KindReading) ref = "";
  return {
    kind, gist: c.gist, body: c.body, outcome: c.outcome, feeling: c.feeling, intensity: c.intensity,
    lesson: c.lesson, people: c.people, pointer: c.pointer, importance: c.importance,
    about, context, from, ref, milestone: kind === KindEpisode && (req.milestone ?? false),
  };
}

// goG is Go's %.{prec}g of a finite number: prec significant digits, an
// exact tie rounded to even, trailing zeros dropped, and the exponent form
// below 1e-4 or from 10^prec.
export function goG(x: number, prec: number): string {
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  // toExponential rounds a tie up. Its 101 digits are exact for any double
  // a tie can be found in.
  const [fullMant, fullExp] = a.toExponential(100).split("e") as [string, string];
  const full = fullMant.replace(".", "");
  let digits: string;
  let exp: number;
  if (full[prec] === "5" && /^0*$/.test(full.slice(prec + 1)) && Number(full[prec - 1]) % 2 === 0) {
    digits = full.slice(0, prec);
    exp = Number(fullExp);
  } else {
    const [m, e] = a.toExponential(prec - 1).split("e") as [string, string];
    digits = m.replace(".", "");
    exp = Number(e);
  }
  digits = digits.replace(/0+$/, "") || "0";
  const nd = digits.length;
  const dp = exp + 1;
  let eprec = prec;
  if (eprec > nd && nd >= dp) eprec = nd;
  if (exp < -4 || exp >= eprec) {
    const mant = digits[0]! + (nd > 1 ? "." + digits.slice(1) : "");
    const e = Math.abs(exp);
    return `${sign}${mant}e${exp < 0 ? "-" : "+"}${e < 10 ? "0" : ""}${e}`;
  }
  const decimals = Math.max((prec > dp ? nd : prec) - dp, 0);
  const at = (i: number): string => (i >= 0 && i < nd ? digits[i]! : "0");
  let out = "";
  if (dp <= 0) out = "0";
  else for (let i = 0; i < dp; i++) out += at(i);
  if (decimals > 0) {
    out += ".";
    for (let i = 0; i < decimals; i++) out += at(dp + i);
  }
  return sign + out;
}

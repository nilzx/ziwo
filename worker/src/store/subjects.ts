// Subjects: what a run of memories is about. A subject is recorded by a
// subject item (kind subject: its name in about, its description in gist),
// and a later subject item takes the place of earlier ones through replaces,
// as a lesson does. Its head is the subject item that stands for it now. An
// item is filed under a subject by the id its event names, resolved when it
// was written; the name lives in the subject items alone, where erase can
// reach it. The functions here run inside the caller's transaction.

import { type Append, KindSubject, writeMemory } from "./content";
import { type Db, text } from "./db";

// subjectKey brings the spellings of a subject's name to one form: case,
// width, spacing and punctuation do not count, so "Guitar practice",
// "guitar-practice" and "guitarpractice" are one subject, and so are
// "吉他 练习" and "吉他练习". carrierKey keeps a "-" where a run of other
// characters stood; this drops it, because Chinese and Japanese are written
// without spaces and a space in a name is no part of it.
export function subjectKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
}

// ripeAfter is how long a session must have written no fragment before the
// fragments of its last burst are ripe, and the gap between two fragments
// of a session that starts a new burst. A fragment of an earlier burst is
// ripe: that stretch of the conversation is over. Put together while it is
// still going on, it would be put together by halves.
export const ripeAfter = 30 * 60 * 1000;

// unsortedKey is the key of the word that, given as a subject, means no
// subject.
export const unsortedKey = "unsorted";

// idForm is what a subject given by id looks like: m_ and eight characters
// of the id alphabet. Such a value is read as an id, never as a name.
export const idForm = /^m_[a-km-np-z2-9]{8}$/;

// Resolved is what a subject given by name or id comes to.
export type Resolved =
  | { none: true } // unsorted: no subject
  | { head: string } // an existing subject, by its head
  | { fresh: string; key: string } // a name no subject has or had: a new subject
  | { refused: "no-letter" | "no-subject" }; // a name of only punctuation, or an id that is no subject

// resolveSubject resolves a subject given by name or id, as a write does. A
// name some subject has now wins over a name one had before; among earlier
// names, the newest wins. So a name merged or renamed away keeps leading to
// the subject that took it over.
export function resolveSubject(db: Db, value: string): Resolved {
  if (idForm.test(value)) {
    const r = db.first(`SELECT kind, subject FROM memories WHERE id = ?`, value);
    if (r === undefined || text(r.kind) !== KindSubject || text(r.subject) === "") return { refused: "no-subject" };
    return { head: text(r.subject) };
  }
  const key = subjectKey(value);
  if (key === "") return { refused: "no-letter" };
  if (key === unsortedKey) return { none: true };
  const r = db.first(
    `SELECT m.subject AS head FROM subject_names k JOIN memories m ON m.id = k.id
      WHERE k.key = ? AND m.subject <> ''
      ORDER BY (m.state = '') DESC, m.n DESC LIMIT 1`,
    key,
  );
  return r === undefined ? { fresh: value, key } : { head: text(r.head) };
}

// writeSubjectItem writes a subject item with the given id: its name, its
// description (possibly ""), the heads it takes the place of, and the items
// it puts under itself. The caller has checked them.
export function writeSubjectItem(
  db: Db, append: Append, at: number, session: string, id: string,
  s: { name: string; description: string; replaces: string[]; from: string[] },
): void {
  writeMemory(
    db, append, at,
    {
      id, session, kind: KindSubject, moment: "", source: "lived", importance: 0.5, intensity: 0, hash: "",
      corrects: "", happened: 0, from: s.from, ref: "", milestone: false, replaces: s.replaces,
    },
    { gist: s.description, about: s.name },
  );
}

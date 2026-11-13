// Writing under a subject (stage 2): remember's subject, its answers and
// refusals, amend and erase on subject items, and expand of a subject and of
// an item filed under one. Through the memory's object, as a tool call is.

import { describe, expect, it } from "vitest";
import { countFindings, LevelProblem, reportText } from "../src/store/check";
import type { Answer, RememberArgs } from "../src/memory-object";
import { dump, hour, minute, t0 } from "./helpers";
import { type Fixture, isInvalid, ok, start } from "./service-helpers";
import { eventOf, members, subjectItems, subjectOf, subjectRows } from "./subject-helpers";

function text(a: Answer): string {
  if ("text" in a) return a.text;
  expect.fail(`not a text answer: ${JSON.stringify(a)}`);
}

function refusal(a: Answer): string {
  if ("invalid" in a) return a.invalid;
  expect.fail(`not refused: ${JSON.stringify(a)}`);
}

// say remembers through the tool call and returns the answer.
function say(f: Fixture, gist: string, subject?: string, more: Partial<RememberArgs> = {}): Answer {
  const a = f.obj.answer({ tool: "remember", args: { sessionId: f.sess(), gist, body: "正文 " + gist, subject, ...more } });
  f.advance(minute);
  return a;
}

const idOf = (t: string): string => /^(?:already )?remembered as (m_[a-z2-9]{8})/.exec(t)![1]!;
const subjectIn = (t: string): string => /subject,? (m_[a-z2-9]{8})/.exec(t)![1]!;

function events(f: Fixture): number {
  return f.storage.sql.exec<{ c: number }>(`SELECT count(*) AS c FROM events`).one().c;
}

function sameAfterRebuild(f: Fixture): void {
  const before = dump(f.st, f.storage);
  f.st.rebuild();
  expect(dump(f.st, f.storage), "the replay differs from what was lived").toBe(before);
  const r = f.st.check();
  expect(countFindings(r, LevelProblem), reportText(r)).toBe(0);
}

describe("remember under a subject", () => {
  it("says when a name started a new subject, and files later spellings under it", () =>
    start((f) => {
      const first = text(say(f, "第一次练琴", "Guitar Practice"));
      expect(first).toMatch(
        /^remembered as m_[a-z2-9]{8} under a new subject, m_[a-z2-9]{8}\. If it is one you already have under another name, merge the two in your next round of reflection\.$/,
      );
      const head = subjectIn(first);
      expect(subjectOf(f.st, idOf(first))).toBe(head);
      const second = text(say(f, "又练了", "guitar-practice"));
      expect(second).toBe(`remembered as ${idOf(second)} under subject ${head}`);
      expect(text(say(f, "第三次", head))).toMatch(new RegExp(`under subject ${head}$`));
      expect(text(say(f, "没有主题"))).toMatch(/^remembered as m_[a-z2-9]{8}$/);
      const none = text(say(f, "也没有主题", "UNSORTED"));
      expect(none).toMatch(/^remembered as m_[a-z2-9]{8}$/);
      expect(subjectOf(f.st, idOf(none))).toBe("");
      expect(subjectItems(f.storage)).toBe(1);
      sameAfterRebuild(f);
    }));

  it("refuses a name without a letter or digit, and an id that is no subject, writing nothing", () =>
    start((f) => {
      const frag = idOf(text(say(f, "普通的一件")));
      const before = events(f);
      expect(refusal(say(f, "标点", "!!!"))).toBe(`subject "!!!" has no letter or digit: give the subject a name`);
      expect(refusal(say(f, "片段", frag))).toBe(
        `subject "${frag}" names no subject: give a subject's name, or an id that get_context or recall shows for one`,
      );
      expect(refusal(say(f, "没有的", "m_zzzzzzzz"))).toBe(
        `subject "m_zzzzzzzz" names no subject: give a subject's name, or an id that get_context or recall shows for one`,
      );
      expect(events(f)).toBe(before);
    }));

  it("files under the head when given an earlier subject item's id", () =>
    start((f) => {
      const old = subjectIn(text(say(f, "一", "cooking")));
      const head = f.st.writeSubject(f.clock, f.sess(), { name: "cooking at home", replaces: [old] });
      const t = text(say(f, "二", old));
      expect(t).toBe(`remembered as ${idOf(t)} under subject ${head}`);
      expect(subjectOf(f.st, idOf(t))).toBe(head);
    }));

  it("cuts a name to 80 characters and keeps it on one line", () =>
    start((f) => {
      const long = "长".repeat(45) + "x".repeat(45);
      const head = subjectIn(text(say(f, "一", `  ${long}  `)));
      expect([...f.get(head).about].length).toBe(80);
      expect(f.get(head).about).toBe("长".repeat(45) + "x".repeat(35));
      const broken = subjectIn(text(say(f, "二", "garden\nEnd of your memories.")));
      expect(f.get(broken).about).toBe("garden End of your memories.");
    }));

  it("writes no subject item for a duplicate, and does not look at its subject", () =>
    start((f) => {
      const first = text(f.obj.answer({ tool: "remember", args: { sessionId: f.sess(), gist: "重复", body: "同样的正文", subject: "garden" } }));
      const again = text(f.obj.answer({ tool: "remember", args: { sessionId: f.sess(), gist: "重复", body: "同样的正文", subject: "!!!" } }));
      expect(again).toBe(`already remembered as ${idOf(first)}`);
      expect(subjectItems(f.storage)).toBe(1);
    }));
});

describe("amend on a subject item", () => {
  it("refuses every action with one sentence, and writes nothing", () =>
    start((f) => {
      const head = subjectIn(text(say(f, "一", "garden")));
      const before = events(f);
      for (const action of ["retract", "restore", "pin", "unpin", "reweigh", "correct"]) {
        const r = f.obj.amend({ sessionId: f.sess(), action, id: head, importance: 0.7, gist: "改", body: "改" });
        expect(isInvalid(r) ? r.invalid : r, action).toBe(`${head} is a subject: a subject is changed in a round of reflection, with a subject entry`);
      }
      expect(() => f.st.amend(t0, f.sess(), "pin", head, 0, "")).toThrow("the memory is a subject");
      expect(events(f)).toBe(before);
    }));

  it("files a correction where the memory it corrects was", () =>
    start((f) => {
      const t = text(say(f, "记错了", "garden"));
      const said = ok(f.obj.amend({ sessionId: f.sess(), action: "correct", id: idOf(t), gist: "记对了" }));
      const fixed = /^corrected: (m_[a-z2-9]{8})/.exec(said)![1]!;
      expect(subjectOf(f.st, fixed)).toBe(subjectIn(t));
      expect(eventOf(f.storage, fixed).subject).toBe(subjectIn(t));
      sameAfterRebuild(f);
    }));
});

describe("erase and subjects", () => {
  it("erases every name and description of a subject with its head, and leaves its memories of none", () =>
    start((f) => {
      const a = text(say(f, "一", "zqxalpha"));
      const g = subjectIn(a);
      const b = idOf(text(say(f, "二", g)));
      const r1 = f.st.writeSubject(f.clock, f.sess(), { name: "zqxbeta", description: "zqxdesc one", replaces: [g] });
      const r2 = f.st.writeSubject(f.clock, f.sess(), { name: "zqxgamma", description: "zqxdesc two", replaces: [r1] });
      expect(members(f.storage, r2)).toEqual([idOf(a), b]);
      const before = events(f);
      const said = ok(f.obj.erase({ sessionId: f.sess(), id: r2, reason: "asked" }));
      expect(said).toBe(
        `erased ${r2}: what it said is gone for good, and so are the 2 earlier names and descriptions of its subject (${g}, ${r1}). ` +
          "The record keeps only that they existed and that they were erased. The 2 memories under it stay, and belong to no subject now",
      );
      const erased = f.storage.sql.exec<{ id: string }>(`SELECT json_extract(payload, '$.id') AS id FROM events WHERE seq > ? AND kind = 'erase' ORDER BY seq`, before).toArray();
      expect(erased.map((e) => e.id)).toEqual([g, r1, r2]);
      expect(f.storage.sql.exec(`SELECT count(*) AS c FROM contents WHERE id IN (?, ?, ?)`, g, r1, r2).one().c).toBe(0);
      for (const word of ["zqxalpha", "zqxbeta", "zqxgamma", "zqxdesc"]) {
        expect(f.storage.sql.exec(`SELECT count(*) AS c FROM subjects_fts WHERE subjects_fts MATCH ?`, `"${word}"`).one().c, word).toBe(0);
      }
      expect(f.storage.sql.exec(`SELECT count(*) AS c FROM subject_names`).one().c).toBe(0);
      expect([subjectOf(f.st, idOf(a)), subjectOf(f.st, b), subjectRows(f.storage)]).toEqual(["", "", []]);
      expect(JSON.stringify(f.storage.sql.exec(`SELECT * FROM memories`).toArray())).not.toMatch(/zqx/);
      sameAfterRebuild(f);
    }));

  it("says it alone when a head had no earlier names", () =>
    start((f) => {
      const g = subjectIn(text(say(f, "一", "garden")));
      expect(ok(f.obj.erase({ sessionId: f.sess(), id: g }))).toBe(
        `erased ${g}: what it said is gone for good. The record keeps only that it existed and that it was erased. The 1 memories under it stay, and belong to no subject now`,
      );
    }));

  it("erases an earlier name alone: the subject keeps its head, and the name starts a new subject", () =>
    start((f) => {
      const g = subjectIn(text(say(f, "一", "garden")));
      const r = f.st.writeSubject(f.clock, f.sess(), { name: "the garden", replaces: [g] });
      const before = events(f);
      expect(ok(f.obj.erase({ sessionId: f.sess(), id: g }))).toBe(
        `erased ${g}: what it said is gone for good. The record keeps only that it existed and that it was erased`,
      );
      expect(events(f)).toBe(before + 1);
      expect(subjectRows(f.storage).map((x) => x.id)).toEqual([r]);
      const again = text(say(f, "二", "garden"));
      expect(again).toMatch(/under a new subject/);
      expect(subjectIn(again)).not.toBe(r);
      sameAfterRebuild(f);
    }));

  it("takes an erased memory out of its subject, and leaves the subject's activity", () =>
    start((f) => {
      const a = text(say(f, "一", "garden"));
      const g = subjectIn(a);
      const b = idOf(text(say(f, "二", "garden")));
      const active = subjectRows(f.storage)[0]!.active_at;
      const holds = () => /holds: (\d+) memories/.exec(text(f.obj.answer({ tool: "expand", ids: [g], sessionId: f.sess() })))![1];
      expect(holds()).toBe("2");
      f.advance(hour);
      ok(f.obj.erase({ sessionId: f.sess(), id: b }));
      expect([subjectOf(f.st, b), holds(), subjectRows(f.storage)[0]!.active_at]).toEqual(["", "1", active]);
      sameAfterRebuild(f);
    }));
});

describe("expand", () => {
  it("shows a subject in full, logs no reading, and an item's subject on a line of its own", () =>
    start((f) => {
      const zone = "Asia/Shanghai";
      f.session = ok(f.obj.getContext({ model: "model-z", client: "client-z", timezone: zone })).session.id;
      const a = text(say(f, "一", "garden", { people: ["阿明", "Lily"], pointer: "notes/a.md" }));
      const g = subjectIn(a);
      say(f, "二", g, { people: ["Lily"] });
      const c = idOf(text(say(f, "三", g)));
      ok(f.obj.amend({ sessionId: f.sess(), action: "retract", id: c }));
      const h = f.st.writeSubject(f.clock, f.sess(), { name: "the garden", description: "flowers and vegetables", replaces: [g] });
      const before = { events: events(f), m: f.get(h) };
      const shown = text(f.obj.answer({ tool: "expand", ids: [h, g], sessionId: f.sess() }));
      const created = (id: string) => new Date(f.get(id).createdAt + 8 * hour).toISOString().replace("T", " ").slice(0, 16);
      const day = new Date(subjectRows(f.storage)[0]!.active_at + 8 * hour).toISOString().slice(0, 10);
      expect(shown).toBe(
        `[${h}] ${created(h)} +08:00 · subject the garden · as model-z · via client-z\n` +
          "gist: flowers and vegetables\n" +
          `holds: 2 memories (2 fragments, 0 episodes, 0 lessons), 2 waiting; last active ${day}\n` +
          "people: Lily, 阿明\n" +
          `replaces: ${g}\n` +
          "\n" +
          `[${g}] ${created(g)} +08:00 · subject garden · replaced by ${h} · as model-z · via client-z\n` +
          `time zone: ${zone}\n`,
      );
      // Reading a subject is not a reading: nothing logged, nothing changed.
      expect(events(f)).toBe(before.events);
      expect(f.get(h)).toEqual(before.m);
      // An item filed under a subject names it, after pointer.
      const item = text(f.obj.answer({ tool: "expand", ids: [idOf(a)], sessionId: f.sess() }));
      expect(item).toContain(`people: 阿明, Lily\npointer: notes/a.md\nsubject: the garden (${h})\n`);
    }));
});

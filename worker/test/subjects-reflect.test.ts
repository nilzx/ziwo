// Reflection by subject (stage 3): which fragments are ripe, a batch of one
// subject or of none, what it shows, and what a round's entries do to
// subjects: filing episodes and lessons, subject entries that start, rename,
// merge, describe and fill subjects, and what they refuse.

import { describe, expect, it } from "vitest";
import type { EntryRequest, ReflectView } from "../src/memory/amend";
import type { Answer } from "../src/memory-object";
import { ripeAfter } from "../src/memory/service";
import { countFindings, LevelProblem, reportText } from "../src/store/check";
import { dump, minute, t0 } from "./helpers";
import { type Fixture, isInvalid, ok, start } from "./service-helpers";
import { eventOf, members, subjectItems, subjectOf, subjectRows } from "./subject-helpers";

function text(a: Answer): string {
  if ("text" in a) return a.text;
  expect.fail(`not a text answer: ${JSON.stringify(a)}`);
}

// under writes a fragment in the fixture's session under subject and returns
// its id and the subject's head.
function under(f: Fixture, gist: string, subject?: string): { id: string; head: string } {
  const r = ok(f.obj.remember({ sessionId: f.sess(), gist, body: "正文 " + gist, subject }));
  f.advance(minute);
  return { id: r.id, head: r.subject?.id ?? "" };
}

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

// round opens a round in a conversation of its own, half an hour after the
// last write, on subject, and writes entries back.
function round(f: Fixture, entries: EntryRequest[], subject?: string, pass: string[] = []): { view: ReflectView; by: string; ids: string[] | string } {
  const by = f.ripen();
  const view = ok(f.obj.beginReflect({ sessionId: by, subject }));
  expect(view.batch, "a batch").not.toBe("");
  const r = f.obj.finishReflect({ sessionId: by, batch: view.batch, entries, pass });
  return { view, by, ids: isInvalid(r) ? r.invalid : r };
}

const episode = (gist: string, from: string[], subject?: string): EntryRequest => ({ kind: "episode", gist, body: "经过", from, subject });
const lesson = (gist: string, from: string[], subject?: string): EntryRequest => ({ kind: "lesson", gist, body: "所得", from, subject });
const subjectEntry = (name: string, gist: string, more: Partial<EntryRequest> = {}): EntryRequest => ({ kind: "subject", subject: name, gist, ...more });

describe("ripeness", () => {
  it("hands out a moment once the stretch of conversation it was written in is over, to any conversation", () =>
    start((f) => {
      const a = under(f, "一", "garden");
      under(f, "二", "garden");
      const last = f.clock - minute;
      const other = f.begin("model-a", "other").session.id;
      // 29 minutes after the last write is too soon; 30 is not.
      f.clock = last + ripeAfter - minute;
      expect(text(f.obj.answer({ tool: "reflect", sessionId: other }))).toBe(
        "2 moments wait, but each was written in a stretch of a conversation that is still going on; reflect on them later",
      );
      f.clock = last + ripeAfter;
      const batchOf = (t: string) => /^batch: (b_[a-z2-9]{8})/.exec(t)![1]!;
      f.st.abandonReflect(other, batchOf(text(f.obj.answer({ tool: "reflect", sessionId: other }))));
      // The conversation that wrote them is no exception.
      const own = ok(f.obj.beginReflect({ sessionId: f.sess() }));
      expect(own.fragments).toHaveLength(2);
      f.st.abandonReflect(f.sess(), own.batch);
      expect(text(f.obj.answer({ tool: "reflect", sessionId: other, subject: "unsorted" }))).toBe("nothing waits to be reflected on");
      expect(a.head).not.toBe("");
    }));

  it("splits a conversation into bursts: an earlier burst is ripe while the latest goes on", () =>
    start((f) => {
      const six = [1, 2, 3, 4, 5, 6].map((i) => under(f, `练${i}`, "guitar").id);
      f.advance(40 * minute);
      const seventh = under(f, "又练了", "guitar").id;
      const other = f.begin("model-a", "other").session.id;
      for (const asking of [f.sess(), other]) {
        const v = ok(f.obj.beginReflect({ sessionId: asking, subject: "guitar", limit: 20 }));
        expect(v.fragments.map((m) => m.id), asking).toEqual(six);
        expect(v.subject?.figures.waiting).toBe(7);
        f.st.abandonReflect(asking, v.batch);
      }
      // A moment within half an hour of the last keeps the burst going.
      f.advance(20 * minute);
      const eighth = under(f, "接着练", "guitar").id;
      f.clock = f.get(eighth).writtenAt + ripeAfter - minute;
      const soon = ok(f.obj.beginReflect({ sessionId: other, subject: "guitar", limit: 20 }));
      expect(soon.fragments.map((m) => m.id)).toEqual(six);
      f.st.abandonReflect(other, soon.batch);
      // Half an hour after its last moment, the latest burst is ripe too.
      f.clock = f.get(eighth).writtenAt + ripeAfter;
      const all = ok(f.obj.beginReflect({ sessionId: other, subject: "guitar", limit: 20 }));
      expect(all.fragments.map((m) => m.id)).toEqual([...six, seventh, eighth]);
      // The first moment of a session starts a burst, and a replay gives the
      // same bursts.
      const bursts = () => f.storage.sql.exec<{ id: string; burst_n: number }>(`SELECT id, burst_n FROM sessions ORDER BY id`).toArray();
      const b = bursts().find((r) => r.id === f.sess())!;
      expect(b.burst_n).toBe(f.get(seventh).n);
      expect(bursts().find((r) => r.id === other)!.burst_n).toBe(0);
      const fresh = f.begin("model-a", "fresh").session.id;
      const first = ok(f.obj.remember({ sessionId: fresh, gist: "第一件", body: "正文" })).id;
      const before = bursts();
      expect(before.find((r) => r.id === fresh)!.burst_n).toBe(f.get(first).n);
      f.st.rebuild();
      expect(bursts()).toEqual(before);
    }));
});

describe("a batch", () => {
  it("is of the subject asked for, or of the one with the most ripe fragments, the unsorted counting as one", () =>
    start((f) => {
      const s = [1, 2, 3, 4, 5].map((i) => under(f, `S${i}`, "garden").id);
      const loose = [1, 2, 3, 4, 5, 6, 7].map((i) => under(f, `U${i}`).id);
      const t = [under(f, "T1", "cooking").id, under(f, "T2", "cooking").id];
      const by = f.ripen();
      const pick = (subject?: string) => {
        const v = ok(f.obj.beginReflect({ sessionId: by, subject }));
        f.st.abandonReflect(by, v.batch);
        return v.fragments.map((m) => m.id).sort();
      };
      expect(pick()).toEqual([...loose].sort());
      expect(pick("Cooking")).toEqual([...t].sort());
      expect(pick("unsorted")).toEqual([...loose].sort());
      // Two more under garden: seven each, and garden's oldest is older.
      s.push(under(f, "S6", "garden").id, under(f, "S7", "garden").id);
      const by2 = f.ripen();
      const v = ok(f.obj.beginReflect({ sessionId: by2 }));
      expect(v.fragments.map((m) => m.id).sort()).toEqual([...s].sort());
      // A name no subject has is refused.
      expect(f.obj.beginReflect({ sessionId: by2, subject: "nothing like it" })).toEqual({
        invalid: `subject "nothing like it" names none of your subjects: recall with a query finds them by what they are about`,
      });
    }));

  it("holds ripe fragments only, nearest to fading first, up to limit, and counts the rest", () =>
    start((f) => {
      const keep = under(f, "重要", "garden");
      f.st.amend(f.clock, f.sess(), "pin", keep.id, 0, "");
      const ids = [1, 2, 3, 4].map((i) => under(f, `第${i}件`, "garden").id);
      const by = f.ripen();
      // Written now by another conversation: not ripe.
      ok(f.obj.remember({ sessionId: f.begin("model-a", "x").session.id, gist: "刚写的", body: "正文", subject: "garden" }));
      const v = ok(f.obj.beginReflect({ sessionId: by, limit: 3 }));
      expect(v.fragments.map((m) => m.id)).toEqual(ids.slice(0, 3));
      expect(v.remaining).toBe(2);
      expect(v.subject?.figures).toEqual({ fragments: 6, episodes: 0, lessons: 0, waiting: 6 });
      f.st.abandonReflect(by, v.batch);
      const all = ok(f.obj.beginReflect({ sessionId: by, limit: 20 }));
      expect(all.fragments.map((m) => m.id)).toEqual([...ids, keep.id]);
      expect(all.remaining).toBe(0);
    }));

  it("shows the subject, what is already held on it, and changes nothing by showing it", () =>
    start((f) => {
      const zone = "Asia/Shanghai";
      const g = under(f, "一", "garden");
      const xs = [2, 3, 4, 5].map((i) => under(f, `${i}`, "garden").id);
      // Episodes and lessons of the subject: one retracted, one replaced.
      const r1 = round(f, [
        episode("第一段", [g.id]), lesson("第一课", [xs[0]!]), lesson("第二课", [xs[0]!]), lesson("被收回", [xs[1]!]),
      ], "garden", [xs[0]!, xs[1]!]);
      const [e1, l1, l2, gone] = r1.ids as string[];
      f.st.amend(f.clock, f.sess(), "retract", gone!, 0, "");
      const r2 = round(f, [lesson("合起来的课", [], undefined)].map((e) => ({ ...e, from: [], replaces: [l1!, l2!] })), "garden", [xs[2]!]);
      const [l3] = r2.ids as string[];
      const fresh = under(f, "新的一件", "garden");
      f.session = ok(f.obj.getContext({ model: "m", client: "c", timezone: zone })).session.id;
      f.advance(ripeAfter);
      const before = f.st.get([e1!, l3!]);
      const n = events(f);
      const shown = text(f.obj.answer({ tool: "reflect", sessionId: f.sess(), subject: "garden" }));
      const batch = /^batch: (b_[a-z2-9]{8})\n/.exec(shown)![1]!;
      const day = (at: number) => new Date(at + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const active = subjectRows(f.storage)[0]!.active_at;
      expect(shown.startsWith(
        `batch: ${batch}\nsubject of this batch:\n[${g.head}] subject garden (7 memories, 2 waiting, last ${day(active)})\n2 fragments to reflect on:\n\n`,
      ), shown).toBe(true);
      expect(shown).toContain(
        `\nwhat you already hold on this subject (expand reads them in full):\n` +
          `[${l3}] ${day(f.get(l3!).createdAt)} lesson: 合起来的课\n[${e1}] ${day(f.get(e1!).createdAt)} episode: 第一段\n`,
      );
      expect(shown.endsWith(
        "Write back with reflect: session_id, this batch, entries, pass. Episodes and lessons go under this subject unless you give another.\n" +
          `time zone: ${zone}\n`,
      )).toBe(true);
      expect(shown).toContain(`[${fresh.id}] `);
      // The lease names the subject; showing held items logged nothing.
      expect(f.st.heldRound()?.subject).toBe(g.head);
      expect(events(f)).toBe(n);
      expect(f.st.get([e1!, l3!])).toEqual(before);
    }));

  it("of the unsorted says so, and asks for subjects", () =>
    start((f) => {
      const a = under(f, "散一").id;
      under(f, "散二");
      const r = round(f, [episode("散的经历", [a])], "unsorted");
      expect(r.view.subject).toBeUndefined();
      under(f, "散三");
      f.session = f.ripen();
      const shown = text(f.obj.answer({ tool: "reflect", sessionId: f.sess() }));
      expect(shown).toMatch(/^batch: b_[a-z2-9]{8}\n2 fragments to reflect on, none of them under a subject yet:\n\n/);
      expect(shown).toContain(`\nwhat you already hold under no subject (expand reads them in full):\n[${(r.ids as string[])[0]}] `);
      expect(shown).toContain(
        "\nWrite back with reflect: session_id, this batch, entries, pass. Give each episode and lesson a subject, and put the fragments you pass under one with a subject entry.\n",
      );
      expect(f.st.heldRound()?.subject).toBe("");
    }));
});

describe("entries and subjects", () => {
  it("files episodes and lessons under the round's subject unless they name another, and impressions under none", () =>
    start((f) => {
      const g = under(f, "一", "garden");
      const t = under(f, "二", "cooking");
      const x = under(f, "三", "garden").id;
      const r = round(f, [
        episode("园子里的一天", [g.id]), lesson("园子的课", [x]), lesson("做饭的课", [x], "Cooking"),
        { kind: "impression", gist: "某人很好", about: "某人", from: [x] },
      ], "garden");
      const [e, l, l2, imp] = r.ids as string[];
      expect([subjectOf(f.st, e!), subjectOf(f.st, l!), subjectOf(f.st, l2!), subjectOf(f.st, imp!)]).toEqual([g.head, g.head, t.head, ""]);
      expect(eventOf(f.storage, imp!).subject).toBeUndefined();
      for (const kind of ["impression", "self", "reading"]) {
        const res = round(f, [{ kind, gist: "g", about: "x", ref: x, from: [x], subject: "garden" }], "garden");
        expect(res.ids, kind).toBe("subject goes with episode, lesson and subject entries only (entry 1)");
      }
      sameAfterRebuild(f);
    }));

  it("files fragments an episode absorbs under its subject when they had none", () =>
    start((f) => {
      const [A, B] = [under(f, "A").id, under(f, "B").id];
      const C = under(f, "C", "cooking");
      const S = under(f, "S", "garden");
      const r = round(f, [episode("合在一起", [A, B, C.id])], "garden");
      const [e] = r.ids as string[];
      expect([subjectOf(f.st, A), subjectOf(f.st, B), subjectOf(f.st, C.id), subjectOf(f.st, e!)]).toEqual([S.head, S.head, C.head, S.head]);
      sameAfterRebuild(f);
    }));

  it("start a subject for a new name, said in the confirmation and not among what was written", () =>
    start((f) => {
      const x = under(f, "一").id;
      const y = under(f, "二").id;
      const by = f.ripen();
      const v = ok(f.obj.beginReflect({ sessionId: by }));
      const said = text(f.obj.answer({
        tool: "reflect", sessionId: by, batch: v.batch,
        entries: [episode("一段", [x], "music"), lesson("一课", [y], "MUSIC!"), lesson("又一课", [y], "painting")],
      }));
      const m = /^wrote (m_\w+) \(episode\), (m_\w+) \(lesson\), (m_\w+) \(lesson\); new subjects (m_\w+), (m_\w+)$/.exec(said);
      expect(m, said).not.toBeNull();
      const [, e, l, l2, music, painting] = m!;
      expect([subjectOf(f.st, e!), subjectOf(f.st, l!), subjectOf(f.st, l2!)]).toEqual([music, music, painting]);
      expect([f.get(music!).about, f.get(painting!).about]).toEqual(["music", "painting"]);
      const wrote = JSON.parse(f.storage.sql.exec<{ w: string }>(`SELECT json_extract(payload, '$.wrote') AS w FROM events WHERE kind = 'reflect'`).one().w);
      expect(wrote).toEqual([e, l, l2]);
      // Written before the entries.
      expect(f.get(music!).n).toBeLessThan(f.get(e!).n);
      sameAfterRebuild(f);
    }));

  it("rename, merge and describe a subject, and put items under it", () =>
    start((f) => {
      const g = under(f, "一", "garden");
      const g2 = under(f, "二", "garden").id;
      f.advance(5 * minute);
      const c = under(f, "三", "cooking");
      const loose = [under(f, "四").id, under(f, "五").id];
      const cActive = subjectRows(f.storage).find((r) => r.id === c.head)!.active_at;

      // Rename: a new name taking the place of garden.
      let r = round(f, [subjectEntry("the garden", "flowers and vegetables", { replaces: [g.head] })], "garden");
      const renamed = (r.ids as string[])[0]!;
      expect([f.get(g.head).state, f.get(g.head).stateBy]).toEqual(["superseded", renamed]);
      expect(members(f.storage, renamed)).toEqual([g.id, g2]);
      expect(f.st.resolveSubject("garden")).toEqual({ head: renamed });
      expect(eventOf(f.storage, renamed)).toMatchObject({ kind: "subject", replaces: [g.head] });
      expect([f.get(renamed).about, f.get(renamed).gist]).toEqual(["the garden", "flowers and vegetables"]);

      // Merge: named as the garden, with cooking in replaces.
      r = round(f, [subjectEntry("The Garden", "flowers, vegetables and cooking", { replaces: [c.head] })], "cooking");
      const merged = (r.ids as string[])[0]!;
      expect(eventOf(f.storage, merged).replaces).toEqual([renamed, c.head]);
      expect(subjectRows(f.storage).map((x) => x.id)).toEqual([merged]);
      expect(members(f.storage, merged)).toEqual([g.id, g2, c.id]);
      expect(subjectRows(f.storage)[0]!.active_at).toBe(Math.max(cActive, f.get(merged).writtenAt));
      expect(f.get(merged).about).toBe("The Garden");

      // Describe it again, by id: the name stays.
      r = round(f, [subjectEntry(merged, "a garden, and the kitchen it feeds")], "unsorted", []);
      const described = (r.ids as string[])[0]!;
      expect([f.get(described).about, f.get(described).gist]).toEqual(["The Garden", "a garden, and the kitchen it feeds"]);
      expect(subjectRows(f.storage).map((x) => x.id)).toEqual([described]);

      // Put the loose ones under it; an absorbed fragment cannot be.
      const e = round(f, [episode("散的合在一起", [loose[0]!])], "unsorted");
      const absorbed = loose[0]!;
      r = round(f, [subjectEntry("the garden", "a garden, and the kitchen it feeds", { from: [loose[1]!, absorbed] })], "unsorted");
      expect(r.ids).toBe(`entry 1: ${absorbed} cannot be put under a subject: only fragments, episodes and lessons that stand can. Nothing was written`);
      r = round(f, [subjectEntry("the garden", "a garden, and the kitchen it feeds", { from: [loose[1]!, (e.ids as string[])[0]!] })], "unsorted");
      const moved = (r.ids as string[])[0]!;
      expect([subjectOf(f.st, loose[1]!), subjectOf(f.st, (e.ids as string[])[0]!)]).toEqual([moved, moved]);
      sameAfterRebuild(f);
    }));

  it("lets an episode name a subject the same round starts, with no subject item of its own", () =>
    start((f) => {
      const x = under(f, "一").id;
      const before = subjectItems(f.storage);
      const r = round(f, [episode("一段", [x], "music practice"), subjectEntry("Music-Practice", "scales and songs")], "unsorted");
      const [e, s] = r.ids as string[];
      expect(subjectOf(f.st, e!)).toBe(s);
      expect(subjectItems(f.storage)).toBe(before + 1);
      expect(f.get(s!).n).toBeLessThan(f.get(e!).n);
      sameAfterRebuild(f);
    }));

  it("files under the subject that took the lease's place since the round opened", () =>
    start((f) => {
      const g = under(f, "一", "garden");
      under(f, "二", "cooking");
      const x = under(f, "三", "garden").id;
      const by = f.ripen();
      const v = ok(f.obj.beginReflect({ sessionId: by, subject: "garden" }));
      const t = f.st.resolveSubject("cooking") as { head: string };
      const merged = f.st.writeSubject(f.clock, by, { name: "cooking", replaces: [t.head, g.head] });
      const [e] = ok(f.obj.finishReflect({ sessionId: by, batch: v.batch, entries: [episode("一段", [x])] }));
      expect(subjectOf(f.st, e!)).toBe(merged);
      sameAfterRebuild(f);
    }));

  it("refuse what cannot be written, and write nothing", () =>
    start((f) => {
      const g = under(f, "一", "garden");
      const c = under(f, "二", "cooking");
      const x = under(f, "三").id;
      const r0 = round(f, [lesson("一课", [x])], "unsorted");
      const l = (r0.ids as string[])[0]!;
      const renamed = round(f, [subjectEntry("the garden", "flowers", { replaces: [g.head] })], "garden").ids as string[];
      const n = events(f);
      const refused = (entries: EntryRequest[]) => round(f, entries, "cooking").ids;
      expect(refused([{ kind: "subject", gist: "g" }])).toBe("subject is required for a subject entry: its name (entry 1)");
      expect(refused([subjectEntry("Unsorted", "g")])).toBe("unsorted is not a name for a subject: it means the moments that belong to none (entry 1)");
      expect(refused([subjectEntry("x", "长".repeat(201))])).toBe("gist is 201 characters, the limit is 200: keep it to one sentence (entry 1)");
      expect(refused([subjectEntry("!!!", "g")])).toBe(`entry 1: subject "!!!" has no letter or digit: give the subject a name. Nothing was written`);
      expect(refused([subjectEntry("new name", "g", { replaces: [l] })])).toBe(
        `entry 1: ${l} in replaces is a lesson: a subject takes the place of earlier subjects only. Nothing was written`,
      );
      expect(refused([subjectEntry("new name", "g", { replaces: [g.head] })])).toBe(
        `entry 1: ${g.head} in replaces has already been replaced, by ${renamed[0]}: name that one. Nothing was written`,
      );
      expect(refused([subjectEntry("cooking", "g"), subjectEntry("COOKING", "h")])).toBe(
        "entry 2 is about the same subject as entry 1: say it in one entry. Nothing was written",
      );
      expect(refused([subjectEntry("cooking", "g"), subjectEntry("x", "h", { replaces: [c.head] })])).toBe(
        "entry 2 is about the same subject as entry 1: say it in one entry. Nothing was written",
      );
      expect(refused([subjectEntry("brand new", "g"), subjectEntry("Brand-New", "h")])).toBe(
        "entry 2 is about the same subject as entry 1: say it in one entry. Nothing was written",
      );
      expect(refused([episode("e", [x], "m_zzzzzzzz")])).toBe(
        `entry 1: subject "m_zzzzzzzz" names no subject: give a subject's name, or an id that get_context or recall shows for one. Nothing was written`,
      );
      // Each round above opened a conversation and a round; nothing else.
      expect(f.storage.sql.exec<{ c: number }>(`SELECT count(*) AS c FROM events WHERE seq > ? AND kind NOT IN ('session')`, n).one().c).toBe(0);
    }));
});

describe("figures", () => {
  it("count what stands in a subject, and its activity is its last write", () =>
    start((f) => {
      const a = under(f, "一", "garden");
      const b = under(f, "二", "garden").id;
      const c = under(f, "三", "garden").id;
      const r = round(f, [episode("一二", [a.id, b]), lesson("课", [c])], "garden");
      const [, l] = r.ids as string[];
      f.st.amend(f.clock, f.sess(), "retract", c, 0, "");
      const holds = () => /holds: ([^;]*);/.exec(text(f.obj.answer({ tool: "expand", ids: [a.head] })))![1];
      expect(holds()).toBe("2 memories (0 fragments, 1 episodes, 1 lessons)");
      const at = f.get(l!).writtenAt;
      expect(subjectRows(f.storage)[0]!.active_at).toBe(at);
      f.advance(minute);
      ok(f.obj.recall({ query: "", sessionId: f.sess() }));
      expect(subjectRows(f.storage)[0]!.active_at).toBe(at);
      expect(t0).toBeLessThan(at);
    }));
});

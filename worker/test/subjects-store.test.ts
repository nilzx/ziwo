// Subjects in the record (stage 1): the subject key, filing a fragment under a
// subject at the store, subject items kept out of what is listed, and every
// replay rule, each checked against what a rebuild makes of the log.

import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { countFindings, LevelNote, LevelProblem, reportText } from "../src/store/check";
import { encodeContent } from "../src/store/content";
import { SubjectError } from "../src/store/errors";
import { encodeRemember, type RememberEvent } from "../src/store/events";
import { textOf } from "../src/memory/embedding";
import { subjectKey } from "../src/store/subjects";
import { thrown } from "./amend-helpers";
import { dump, freshObject, get, hour, inObject, populate, search, session, t0, testParams, unit, withStore } from "./helpers";
import { adminSecret, createMemory, fetchWorker, freshName } from "./mcp-helpers";
import type { Memory as MemoryObject } from "../src/memory-object";
import { eventOf, fragment, members, rem, subjectItems, subjectOf, subjectRows } from "./subject-helpers";

function rebuildsTheSame(s: Parameters<typeof dump>[0], storage: DurableObjectStorage): void {
  const before = dump(s, storage);
  s.rebuild();
  expect(dump(s, storage), "the replay differs from what was lived").toBe(before);
  const r = s.check();
  expect(countFindings(r, LevelProblem), reportText(r)).toBe(0);
}

describe("the subject key", () => {
  it("lets case, width, spacing and punctuation not count, in Chinese too", () => {
    const one = ["Guitar Practice", "guitar-practice", "GUITAR  practice!", "ｇｕｉｔａｒ practice", "guitarpractice"];
    expect(new Set(one.map(subjectKey))).toEqual(new Set(["guitarpractice"]));
    const two = ["吉他 练习", "吉他练习", "吉他·练习", "吉他，练习"];
    expect(new Set(two.map(subjectKey))).toEqual(new Set(["吉他练习"]));
    expect(new Set(["吉他", "练习", "吉他练习"].map(subjectKey)).size).toBe(3);
    expect(subjectKey("!!!")).toBe("");
    expect(subjectKey(" Unsorted ")).toBe("unsorted");
  });
});

describe("remember with a subject", () => {
  it("files the fragment under the head, and a new name writes a subject item first", () =>
    withStore((s, storage) => {
      const a = session(s, t0, "", "cli");
      const first = rem(s, a, "第一次练琴", "Guitar Practice");
      expect(first.subject?.started).toBe(true);
      const head = first.subject!.id;
      expect(subjectOf(s, first.id)).toBe(head);
      const item = get(s, head);
      expect([item.kind, item.about, item.gist, item.core, item.subject, item.pending]).toEqual(["subject", "Guitar Practice", "", true, head, false]);
      expect(storage.sql.exec(`SELECT data FROM contents WHERE id = ?`, head).one().data).toBe(`{"gist":"","about":"Guitar Practice"}`);
      // The fragment's event names the subject by id, last.
      const ev = eventOf(storage, first.id);
      expect(ev.subject).toBe(head);
      expect(Object.keys(ev).at(-1)).toBe("subject");
      expect(eventOf(storage, head)).toMatchObject({ kind: "subject", moment: "", source: "lived", importance: 0.5 });
      expect(eventOf(storage, head).subject).toBeUndefined();
      // Another spelling of the same name: the same subject, no new item.
      for (const name of ["guitar-practice", "GUITAR  practice!", "ｇｕｉｔａｒ practice"]) {
        const r = rem(s, a, `又练了 ${name}`, name);
        expect(r.subject).toEqual({ id: head, started: false });
      }
      expect(members(storage, head)).toHaveLength(4);
      // Chinese: four spellings, one subject; two other names, two more.
      const zh = ["吉他 练习", "吉他练习", "吉他·练习", "吉他，练习"].map((n) => rem(s, a, `练 ${n}`, n).subject!.id);
      expect(new Set(zh).size).toBe(1);
      const others = ["吉他", "练习"].map((n) => rem(s, a, `只 ${n}`, n).subject!);
      expect(others.map((o) => o.started)).toEqual([true, true]);
      expect(new Set([head, zh[0], others[0]!.id, others[1]!.id]).size).toBe(4);
      expect(subjectItems(storage)).toBe(4);
      expect(subjectRows(storage)).toHaveLength(4);
      rebuildsTheSame(s, storage);
    }));

  it("takes unsorted as no subject, refuses a name without a letter, and takes an id", () =>
    withStore((s, storage) => {
      const a = session(s, t0, "", "cli");
      const none = rem(s, a, "无主题", "Unsorted");
      expect([none.subject, subjectOf(s, none.id), subjectItems(storage)]).toEqual([undefined, "", 0]);
      expect(eventOf(storage, none.id).subject).toBeUndefined();

      const before = s.counts();
      const e = thrown(() => rem(s, a, "标点", "!!!"));
      expect([e instanceof SubjectError, (e as SubjectError).reason]).toEqual([true, "no-letter"]);
      expect(s.counts()).toEqual(before);

      const head = rem(s, a, "猫的事", "my cat").subject!.id;
      expect(rem(s, a, "又是猫", head).subject).toEqual({ id: head, started: false });
      const frag = fragment(s, a, "普通的一件事");
      for (const bad of [frag, "m_zzzzzzzz"]) {
        const counts = s.counts();
        const err = thrown(() => rem(s, a, `用 ${bad}`, bad));
        expect([err instanceof SubjectError, (err as SubjectError).reason]).toEqual([true, "no-subject"]);
        expect(s.counts()).toEqual(counts);
      }
      // An earlier subject item files under the head that took its place.
      const renamed = s.writeSubject(t0, a, { name: "cat life", replaces: [head] });
      const via = rem(s, a, "经由旧条目", head);
      expect(via.subject).toEqual({ id: renamed, started: false });
      expect(subjectOf(s, via.id)).toBe(renamed);
      rebuildsTheSame(s, storage);
    }));

  it("resolves a name to the subject that has it now before one that had it, and the newest of those that had it", () =>
    withStore((s) => {
      const a = session(s, t0, "", "cli");
      // garden was a name of x, and of y after it; then z takes it as its
      // own name (written by the store alone: a round would refuse it).
      const x1 = s.writeSubject(t0, a, { name: "garden" });
      const x2 = s.writeSubject(t0, a, { name: "yard", replaces: [x1] });
      expect(s.resolveSubject("Garden")).toEqual({ head: x2 });
      const y1 = s.writeSubject(t0, a, { name: "garden" });
      const y2 = s.writeSubject(t0, a, { name: "patch", replaces: [y1] });
      expect(s.resolveSubject("garden")).toEqual({ head: y2 });
      const z = s.writeSubject(t0, a, { name: "GARDEN" });
      expect(s.resolveSubject("garden")).toEqual({ head: z });
      expect(s.resolveSubject("yard")).toEqual({ head: x2 });
    }));

  it("writes no subject item for a duplicate", () =>
    withStore((s, storage) => {
      const a = session(s, t0, "", "cli");
      const first = rem(s, a, "重复的事", "cooking");
      const again = rem(s, a, "重复的事", "cooking again", t0 + 60_000);
      expect([again.dup, again.id, again.subject]).toEqual([true, first.id, undefined]);
      const plain = rem(s, a, "另一件", undefined, t0);
      expect(rem(s, a, "另一件", "garden", t0 + 60_000)).toEqual({ id: plain.id, dup: true });
      expect(subjectItems(storage)).toBe(1);
    }));

  it("moves the clock by the fragment alone", () =>
    withStore((s) => {
      const a = session(s, t0, "", "cli");
      fragment(s, a, "先一件");
      const before = s.clock();
      rem(s, a, "开了新主题", "garden");
      expect(s.clock()).toBe(before + 1);
      s.writeSubject(t0, a, { name: "cooking", description: "food" });
      expect(s.clock()).toBe(before + 1);
    }));

  it("starts a burst with a session's first fragment, whenever it was written", () =>
    withStore((s, storage) => {
      // Times near the start of the clock: a first fragment written less
      // than half an hour after zero still starts its session's burst.
      const a = s.startSession(1000, "", "cli").session.id;
      const first = rem(s, a, "第一件", undefined, 2000).id;
      const second = rem(s, a, "第二件", undefined, 3000).id;
      const burst = () => storage.sql.exec<{ burst_n: number }>(`SELECT burst_n FROM sessions WHERE id = ?`, a).one().burst_n;
      expect(burst()).toBe(get(s, first).n);
      expect(get(s, second).n).toBeGreaterThan(burst());
      s.rebuild();
      expect(burst()).toBe(get(s, first).n);
    }));

  it("keeps when a session last wrote a fragment", () =>
    withStore((s, storage) => {
      const a = session(s, t0, "", "cli");
      const wrote = () => storage.sql.exec(`SELECT wrote_at FROM sessions WHERE id = ?`, a).one().wrote_at;
      expect(wrote()).toBe(0);
      fragment(s, a, "一件", "garden", t0 + hour);
      expect(wrote()).toBe(t0 + hour);
      // A subject item, a listing and a reading do not count as writing.
      s.writeSubject(t0 + 2 * hour, a, { name: "cooking" });
      s.logRecalls([{ at: t0 + 3 * hour, session: a, query: "q", ids: [] }]);
      expect(wrote()).toBe(t0 + hour);
      expect(storage.sql.exec(`SELECT last_active_at FROM sessions WHERE id = ?`, a).one().last_active_at).toBe(t0 + 3 * hour);
      rebuildsTheSame(s, storage);
    }));
});

describe("subject items", () => {
  it("are not memories: not counted, listed, searched or core", () =>
    withStore((s, storage) => {
      const a = session(s, t0, "", "cli");
      const f1 = fragment(s, a, "关于 guitar 的一件事", "guitar music");
      const f2 = fragment(s, a, "另一件事");
      s.writeSubject(t0, a, { name: "garden", description: "guitar music cooking" });
      expect(s.tierCounts(s.clock())).toEqual({ core: 0, active: 2, faded: 0, archived: 0 });
      expect(s.recent(s.clock(), 10).map((m) => m.id)).toEqual([f2, f1]);
      expect(s.inSpanList(s.clock(), {}, true, 10).map((m) => m.id)).toEqual([f2, f1]);
      expect(s.core(10)).toEqual([]);
      expect(search(s, "garden", true)).toEqual([]);
      expect(search(s, "music", true)).toEqual([]);
      const r = s.check();
      expect(r.figures.find((f) => f.name === "by kind")?.value).toBe("fragment 2");
      expect(r.figures.find((f) => f.name === "memories")?.value).toMatch(/^2 standing \(0 core, 2 active/);
      expect(subjectItems(storage)).toBe(2);
    }));

  it("are embedded by name and description, the heads alone", () =>
    withStore((s) => {
      const a = session(s, t0, "", "cli");
      const first = rem(s, a, "第一件", "guitar");
      const head = first.subject!.id;
      const f = fragment(s, a, "第二件");
      const label = { model: "embed-x", dims: 3 };
      const n = (id: string) => get(s, id).n;
      expect(s.tendVectors(label).waiting).toEqual([n(head), n(first.id), n(f)]);
      expect(textOf(get(s, head))).toBe("guitar\n");
      const renamed = s.writeSubject(t0, a, { name: "guitar practice", description: "chords", replaces: [head] });
      expect(textOf(get(s, renamed))).toBe("guitar practice\nchords");
      const waiting = s.tendVectors(label).waiting;
      expect([waiting.includes(n(head)), waiting.includes(n(renamed))]).toEqual([false, true]);
      // Stored, a head's vector is found by a search kept to the heads, and
      // a search that leaves subject items out never sees it.
      expect(s.saveVectors(label, [{ n: n(renamed), vec: unit([1, 0, 0]) }, { n: n(f), vec: unit([1, 0.1, 0]) }])).toBe(2);
      expect(s.saveVectors(label, [{ n: n(head), vec: unit([1, 0, 0]) }])).toBe(0);
      const q = new Float32Array(unit([1, 0, 0]));
      const { all, heads } = s.subjectNs();
      expect([...heads]).toEqual([n(renamed)]);
      expect([...all].sort()).toEqual([n(head), n(renamed)].sort());
      expect(s.searchVectors(label, q, 5, 0.1).map((h) => h.n)).toEqual([n(renamed), n(f)]);
      expect(s.searchVectors(label, q, 5, 0.1, undefined, all).map((h) => h.n)).toEqual([n(f)]);
      expect(s.searchVectors(label, q, 5, 0.1, heads).map((h) => h.n)).toEqual([n(renamed)]);
    }));

  it("are found by keyword in a name or a description, an old name finding the head", () =>
    withStore((s) => {
      const a = session(s, t0, "", "cli");
      const g = rem(s, a, "一件", "guitar practice").subject!.id;
      const m = s.writeSubject(t0, a, { name: "guitar practice", description: "music and chords", replaces: [g] });
      const c = s.writeSubject(t0, a, { name: "cooking", description: "food" });
      expect(s.searchSubjects("music", 3)).toEqual([{ head: m, score: expect.any(Number) }]);
      expect(s.searchSubjects("guitar", 3).map((x) => x.head)).toEqual([m]);
      const renamed = s.writeSubject(t0, a, { name: "吉他", description: "music and chords", replaces: [m] });
      expect(s.searchSubjects("guitar", 3).map((x) => x.head)).toEqual([renamed]);
      expect(s.searchSubjects("吉他", 3).map((x) => x.head)).toEqual([renamed]);
      expect(s.searchSubjects("cooking food", 3).map((x) => x.head)).toEqual([c]);
    }));

  it("take no part in how items rank", async () => {
    const run = (withSubjects: boolean) =>
      withStore((s) => {
        const a = session(s, t0, "", "cli");
        for (let i = 0; i < 12; i++) fragment(s, a, `guitar ${i % 3 === 0 ? "music" : "practice"} 第${i}次`);
        if (withSubjects) {
          for (let i = 0; i < 10; i++) s.writeSubject(t0, a, { name: `guitar music ${i}`, description: "guitar practice music" });
        }
        return ["guitar", "music practice", "guitar music"].map((q) => s.searchText(q, s.clock(), false, 20).map((h) => `${h.n} ${h.score}`));
      });
    const [plain, subjects] = [await run(false), await run(true)];
    expect(subjects).toEqual(plain);
    expect(plain.flat().length).toBeGreaterThan(10);
  });
});

describe("the replay rules", () => {
  it("rename, merge, description and from: members follow, names resolve, the record replays", () =>
    withStore((s, storage) => {
      const a = session(s, t0, "", "cli");
      const g = rem(s, a, "练琴一", "guitar", t0 + hour).subject!.id;
      const g2 = fragment(s, a, "练琴二", "guitar", t0 + 2 * hour);
      const c = rem(s, a, "做饭一", "cooking", t0 + 5 * hour).subject!.id;
      const c1 = members(storage, c)[0]!;
      const loose = [fragment(s, a, "散的一"), fragment(s, a, "散的二")];

      // Rename: the new name stands in for the old.
      const r = s.writeSubject(t0 + 3 * hour, a, { name: "guitar practice", replaces: [g] });
      expect([get(s, g).state, get(s, g).stateBy, get(s, g).subject]).toEqual(["superseded", r, r]);
      expect(members(storage, r)).toHaveLength(2);
      expect(subjectOf(s, g2)).toBe(r);
      expect(s.resolveSubject("Guitar")).toEqual({ head: r });
      expect(eventOf(storage, r).replaces).toEqual([g]);
      // Its activity is the later of its own write and what it replaced.
      expect(subjectRows(storage).find((x) => x.id === r)?.active_at).toBe(t0 + 3 * hour);

      // Merge: cooking becomes the guitar subject, which keeps the later activity.
      const m = s.writeSubject(t0 + 4 * hour, a, { name: "guitar practice", replaces: [r, c] });
      expect(subjectRows(storage).map((x) => [x.id, x.active_at])).toEqual([[m, t0 + 5 * hour]]);
      expect(subjectOf(s, c1)).toBe(m);
      expect([get(s, c).state, get(s, c).stateBy, get(s, r).subject, get(s, g).subject]).toEqual(["superseded", m, m, m]);
      expect(s.resolveSubject("cooking")).toEqual({ head: m });

      // Description rewritten: the head changes, the name stays.
      const d = s.writeSubject(t0 + 6 * hour, a, { name: "guitar practice", description: "chords and scales", replaces: [m] });
      expect(subjectRows(storage).map((x) => x.id)).toEqual([d]);
      expect([get(s, d).about, get(s, d).gist]).toEqual(["guitar practice", "chords and scales"]);
      expect(members(storage, d)).toHaveLength(3);

      // from: items put under it; an erased one is not.
      s.erase(t0 + 7 * hour, a, loose[1]!, "");
      const t = s.writeSubject(t0 + 7 * hour, a, { name: "garden", from: [loose[0]!, loose[1]!] });
      expect([subjectOf(s, loose[0]!), subjectOf(s, loose[1]!)]).toEqual([t, ""]);
      // from is not a link.
      expect(storage.sql.exec(`SELECT count(*) AS c FROM links`).one().c).toBe(0);
      rebuildsTheSame(s, storage);
    }));

  it("files a fragment absorbed by an episode under the episode's subject when it had none", () =>
    withStore((s, storage) => {
      const a = session(s, t0, "", "cli");
      const S = rem(s, a, "主题S的一件", "garden").subject!.id;
      const T = rem(s, a, "主题T的一件", "cooking").subject!.id;
      const [A, B] = [fragment(s, a, "散的A"), fragment(s, a, "散的B")];
      const C = fragment(s, a, "T下的C", "cooking");
      // An episode under S, from A, B and C, as a round would write it.
      const c = encodeContent({ gist: "一段经历", body: "经过" });
      storage.sql.exec(`INSERT INTO contents(id, data) VALUES('m_ep000001', ?)`, c.data);
      const e: RememberEvent = {
        id: "m_ep000001", session: a, kind: "episode", moment: "", source: "lived", importance: 0.5, intensity: 0,
        hash: c.hash, corrects: "", happened: 0, from: [A, B, C], ref: "", milestone: false, subject: S,
      };
      storage.sql.exec(`INSERT INTO events(at, kind, payload) VALUES(?, 'remember', ?)`, t0 + hour, encodeRemember(e));
      s.rebuild();
      expect([subjectOf(s, A), subjectOf(s, B), subjectOf(s, C), subjectOf(s, "m_ep000001")]).toEqual([S, S, T, S]);
      expect(get(s, A).state).toBe("absorbed");
      expect(subjectRows(storage).find((x) => x.id === S)?.active_at).toBe(t0 + hour);
      rebuildsTheSame(s, storage);
    }));

  it("erases a member, an earlier name, and a head, each as lived", () =>
    withStore((s, storage) => {
      const a = session(s, t0, "", "cli");
      const g = rem(s, a, "一", "guitar", t0 + hour).subject!.id;
      const f2 = fragment(s, a, "二", "guitar", t0 + 2 * hour);
      const f3 = fragment(s, a, "三", "guitar", t0 + 2 * hour);
      const r = s.writeSubject(t0 + 3 * hour, a, { name: "guitar practice", description: "music", replaces: [g] });
      const active = () => subjectRows(storage).find((x) => x.id === r)?.active_at;
      expect(active()).toBe(t0 + 3 * hour);

      // A member leaves its subject; the subject's activity stays.
      s.erase(t0 + 4 * hour, a, f2, "");
      expect(subjectOf(s, f2)).toBe("");
      expect(s.subjectFigures([r]).get(r)).toEqual({ fragments: 2, episodes: 0, lessons: 0, waiting: 2 });
      expect(active()).toBe(t0 + 3 * hour);

      // An earlier name, alone: the subject keeps its head, the name no
      // longer resolves.
      s.erase(t0 + 5 * hour, a, g, "");
      expect(storage.sql.exec(`SELECT count(*) AS c FROM events WHERE kind = 'erase'`).one().c).toBe(2);
      expect([get(s, g).state, get(s, g).subject, get(s, g).about, subjectRows(storage).map((x) => x.id)]).toEqual(["erased", "", "", [r]]);
      expect(s.resolveSubject("guitar")).toEqual({ fresh: "guitar", key: "guitar" });
      expect(s.searchSubjects("guitar", 3).map((x) => x.head)).toEqual([r]); // by the head's own name
      rebuildsTheSame(s, storage);

      // The head: the subject is gone, its members belong to none.
      s.erase(t0 + 6 * hour, a, r, "");
      expect([subjectRows(storage), subjectOf(s, f3), get(s, r).subject]).toEqual([[], "", ""]);
      expect(storage.sql.exec(`SELECT count(*) AS c FROM subject_names`).one().c).toBe(0);
      expect(s.searchSubjects("guitar music", 3)).toEqual([]);
      expect(s.resolveSubject("guitar practice")).toEqual({ fresh: "guitar practice", key: "guitarpractice" });
      rebuildsTheSame(s, storage);
    }));

  it("files under a subject item that is erased later until the erasure, and none after", () =>
    withStore((s, storage) => {
      const a = session(s, t0, "", "cli");
      const g = rem(s, a, "一", "guitar").subject!.id;
      const f = fragment(s, a, "二", "guitar");
      expect(subjectOf(s, f)).toBe(g);
      s.erase(t0 + hour, a, g, "");
      const after = fragment(s, a, "三", "guitar");
      expect([subjectOf(s, f), subjectOf(s, after) !== "", subjectOf(s, after) !== g]).toEqual(["", true, true]);
      // The fragment's event still names the erased item; a replay files it
      // there until the erase event, and under none after it.
      expect(eventOf(storage, f).subject).toBe(g);
      rebuildsTheSame(s, storage);
    }));

  it("marks a subject item erased that lost its content, and its members of none", () =>
    withStore((s, storage) => {
      const a = session(s, t0, "", "cli");
      const g = rem(s, a, "一", "guitar").subject!.id;
      const f = fragment(s, a, "二", "guitar");
      storage.sql.exec(`DELETE FROM contents WHERE id = ?`, g);
      s.rebuild();
      expect([get(s, g).state, get(s, g).subject, subjectOf(s, f), subjectRows(storage)]).toEqual(["erased", "", "", []]);
      expect(s.check().findings.find((x) => x.code === "content-lost")?.ids).toEqual([g]);
      expect(s.check().findings.find((x) => x.code === "subject-off")).toBeUndefined();
    }));

  it("leaves every memory written before subjects unsorted", () =>
    withStore((s, storage) => {
      populate(s);
      s.rebuild();
      expect(storage.sql.exec(`SELECT count(*) AS c FROM memories WHERE subject <> ''`).one().c).toBe(0);
      expect(subjectRows(storage)).toEqual([]);
    }));
});

describe("a store built before subjects", () => {
  it("creates the subjects' index and replays once", async () => {
    const stub = freshObject();
    await inObject(stub, (s, storage) => {
      s.setParams(testParams());
      populate(s);
      // Stand in for a store at derived version 11 and index version 1.
      storage.sql.exec(`DROP TABLE subjects_fts`);
      storage.sql.exec(`UPDATE meta SET value = '1' WHERE key = 'index'`);
      storage.sql.exec(`UPDATE meta SET value = '11' || substr(value, 3) WHERE key = 'derived'`);
      storage.sql.exec(`UPDATE memories SET recall_count = 99`);
    });
    await evictDurableObject(stub);
    const opened = await inObject(stub, (_s, storage) => {
      const meta = Object.fromEntries(storage.sql.exec<{ key: string; value: string }>(`SELECT key, value FROM meta WHERE key IN ('index', 'derived')`).toArray().map((r) => [r.key, r.value]));
      const fts = storage.sql.exec(`SELECT count(*) AS c FROM sqlite_master WHERE name = 'subjects_fts'`).one().c;
      const replayed = storage.sql.exec(`SELECT count(*) AS c FROM memories WHERE recall_count = 99`).one().c === 0;
      storage.sql.exec(`UPDATE memories SET recall_count = 77`);
      return { index: meta.index, derived: meta.derived!.slice(0, 3), fts, replayed };
    });
    expect(opened).toEqual({ index: "2", derived: "12 ", fts: 1, replayed: true });
    await evictDurableObject(stub);
    const again = await inObject(stub, (_s, storage) => storage.sql.exec(`SELECT count(*) AS c FROM memories WHERE recall_count = 77`).one().c);
    expect(again).toBeGreaterThan(0);
  });
});

describe("the check", () => {
  it("gives the subjects' figure, notes a subject of one, and names no name", () =>
    withStore((s) => {
      const a = session(s, t0, "", "cli");
      const marks = ["zqxname", "zqxdescription"];
      const one = rem(s, a, "一", "zqxname").subject!.id;
      s.writeSubject(t0, a, { name: "zqxname", description: "zqxdescription", replaces: [one] });
      const two = rem(s, a, "二", "garden").subject!.id;
      fragment(s, a, "三", "garden");
      fragment(s, a, "四");
      const r = s.check();
      const text = reportText(r);
      expect(r.figures.find((f) => f.name === "subjects")?.value).toBe("2 (2 with moments waiting); 1 memories belong to no subject");
      const single = r.findings.find((f) => f.code === "subject-of-one");
      expect([single?.level, single?.text, single?.ids.length]).toEqual([LevelNote, "1 subjects hold a single memory; one may be a slip, to merge in a round of reflection", 1]);
      expect(single?.ids[0]).not.toBe(two);
      for (const m of marks) expect(text).not.toContain(m);
      expect(JSON.stringify(r)).not.toMatch(/zqx/);
    }));

  it("finds members of a subject that does not stand, and a subjects table that disagrees", () =>
    withStore((s, storage) => {
      const a = session(s, t0, "", "cli");
      const g = rem(s, a, "一", "guitar").subject!.id;
      const f = fragment(s, a, "二", "guitar");
      expect(s.check().findings.find((x) => x.code === "subject-off")).toBeUndefined();
      storage.sql.exec(`DELETE FROM subjects`);
      let found = s.check().findings.find((x) => x.code === "subject-off");
      expect([found?.level, found?.ids]).toEqual([LevelProblem, [g]]);
      expect(found?.text).toBe("1 memories are filed under a subject that does not stand, or the subjects table disagrees with the subject items: run rebuild");
      s.rebuild();
      storage.sql.exec(`UPDATE memories SET subject = 'm_gone0000' WHERE id = ?`, f);
      found = s.check().findings.find((x) => x.code === "subject-off");
      expect(found?.ids).toEqual([f]);
      s.rebuild();
      expect(s.check().findings.find((x) => x.code === "subject-off")).toBeUndefined();
    }));

  it("finds a remember event whose subject names no memory", () =>
    withStore((s, storage) => {
      const a = session(s, t0, "", "cli");
      const c = encodeContent({ gist: "孤立", body: "正文" });
      storage.sql.exec(`INSERT INTO contents(id, data) VALUES('m_lonely01', ?)`, c.data);
      const e: RememberEvent = {
        id: "m_lonely01", session: a, kind: "", moment: "other", source: "lived", importance: 0.5, intensity: 0,
        hash: c.hash, corrects: "", happened: 0, from: [], ref: "", milestone: false, subject: "m_nothing0",
      };
      storage.sql.exec(`INSERT INTO events(at, kind, payload) VALUES(?, 'remember', ?)`, t0, encodeRemember(e));
      s.rebuild();
      expect(subjectOf(s, "m_lonely01")).toBe("");
      expect(s.check().findings.find((x) => x.code === "link-broken")?.ids).toEqual(["m_lonely01"]);
    }));
});

describe("an export", () => {
  const admin = (path: string, body?: string) =>
    fetchWorker(path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${adminSecret}` }, body });
  const inMemory = <R>(name: string, fn: (obj: MemoryObject, storage: DurableObjectStorage) => R) =>
    runInDurableObject(env.MEMORY.getByName(name), (obj: MemoryObject, state) => fn(obj, state.storage));

  it("carries the subject items and the subject fields, and comes back the same", async () => {
    const from = await createMemory();
    const heads = await inMemory(from.name, (obj) => {
      const s = obj.store;
      const a = session(s, t0, "model-a", "cli");
      const g = rem(s, a, "一", "guitar").subject!.id;
      fragment(s, a, "二", "guitar");
      const c = rem(s, a, "三", "cooking").subject!.id;
      const m = s.writeSubject(t0 + hour, a, { name: "guitar practice", description: "music", replaces: [g, c] });
      const e = rem(s, a, "四", "garden").subject!.id;
      s.erase(t0 + 2 * hour, a, e, "");
      return { m };
    });
    const file = await (await admin(`/admin/memories/${from.name}/export`)).text();
    expect(file).toMatch(/"subject":"m_[a-z2-9]{8}"/);
    expect(file).toContain("guitar practice");
    expect(file).toContain(`"kind":"subject"`);
    const to = freshName();
    expect((await admin(`/admin/memories/${to}/import`, file)).status).toBe(201);
    const [a, b] = await Promise.all([from.name, to].map((n) => inMemory(n, (obj, storage) => ({
      dump: dump(obj.store, storage).split("\n"),
      restoreAt: storage.sql.exec<{ at: number }>(`SELECT COALESCE(MAX(at), 0) AS at FROM restores`).one().at,
      problems: countFindings(obj.check(), LevelProblem),
      format: storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'log_format'`).one().value,
    }))));
    expect(b!.dump.filter((l) => !l.startsWith(`[${b!.restoreAt},`))).toEqual(a!.dump);
    expect(a!.dump.some((l) => l.includes(heads.m))).toBe(true);
    expect([a!.problems, b!.problems, a!.format, b!.format]).toEqual([0, 0, "3", "3"]);
    expect(file.slice(0, file.indexOf("\n"))).toContain(`"log_format":3`);
  });
});

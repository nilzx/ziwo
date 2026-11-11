// Port of internal/store/decay_test.go.

import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  defaultParams,
  initialStrength,
  InvalidParamsError,
  type Params,
  retentionOf,
  type Tier,
  type TierCounts,
  tierOf,
  tierTotal,
} from "../src/store/decay";
import type { Memory } from "../src/store/types";
import {
  dump,
  fill,
  freshObject,
  get,
  inObject,
  listed,
  near,
  read,
  remember,
  rememberWith,
  search,
  session,
  t0,
  testParams,
  withStore,
} from "./helpers";

// With testParams the strength of an ordinary memory is 10, so it fades
// 10*ln(1/0.3) = 12.04 memories after it last came to mind and is archived
// 10*ln(20) = 29.96 memories after.
const fadeAfter = 12.039728;
const archiveAfter = 29.957323;

describe("decay", () => {
  it("InitialStrength", () => {
    const p = defaultParams(); // base strength 100
    const cases: [number, number, string, number][] = [
      [0.5, 0, "lived", 100],
      [1.0, 0, "lived", 400],
      [0.0, 0, "lived", 25],
      [0.75, 0, "lived", 200],
      [0.5, 1, "lived", 200],
      [0.5, 0.5, "lived", 150],
      [0.5, 0, "told", 70],
      [0.5, 0, "inferred", 40],
    ];
    for (const [importance, intensity, source, want] of cases) {
      near(initialStrength(p, importance, intensity, source), want, 1e-9);
    }
  });

  // In Go the parameters were checked when a file was opened; here they
  // belong to the memory and are checked when they are set.
  it("ParamsAreValidated", () =>
    withStore((s) => {
      const bad: ((p: Params) => void)[] = [
        (p) => (p.baseStrength = 0),
        (p) => (p.recallBoost = -1),
        (p) => (p.fadeBelow = 1),
        (p) => (p.archiveBelow = 0),
        (p) => (p.archiveBelow = p.fadeBelow),
        (p) => (p.coreImportance = 0),
        (p) => (p.baseStrength = NaN),
      ];
      bad.forEach((change, i) => {
        const p = defaultParams();
        change(p);
        expect(() => s.setParams(p), `case ${i}`).toThrow(InvalidParamsError);
      });
      expect(s.params()).toEqual(testParams());
    }));

  it("MemoryFadesAsNewerOnesAreWritten", () =>
    withStore((s) => {
      const sess = session(s, t0, "", "cli");
      const id = remember(s, t0, sess, "用户给我看了他的猫", "一只橘猫，名字叫年糕。");

      const m = get(s, id);
      near(m.strength, 10, 1e-9);
      expect([m.core, m.ord, m.touchedOrd, m.readOrd]).toEqual([false, 1, 1, 1]);
      near(m.fadeAt, 1 + fadeAfter, 1e-5);
      near(m.archiveAt, 1 + archiveAfter, 1e-5);
      near(retentionOf(m, 11), Math.exp(-1), 1e-9);

      // Time alone forgets nothing: ten years on, with nothing lived
      // through, the clock has not moved.
      session(s, Date.UTC(2036, 10, 11, 8), "", "cli");
      expect(s.clock()).toBe(1);
      expect(tierOf(m, s.clock())).toBe("active");

      let written = 0;
      const cases: {
        newer: number;
        tier: Tier;
        counts: TierCounts;
        gist: boolean;
        body: boolean;
        deep: boolean;
        recent: boolean;
      }[] = [
        { newer: 12, tier: "active", counts: { core: 0, active: 13, faded: 0, archived: 0 }, gist: true, body: true, deep: true, recent: true },
        { newer: 13, tier: "faded", counts: { core: 0, active: 13, faded: 1, archived: 0 }, gist: true, body: false, deep: true, recent: true },
        { newer: 29, tier: "faded", counts: { core: 0, active: 13, faded: 17, archived: 0 }, gist: true, body: false, deep: true, recent: true },
        { newer: 30, tier: "archived", counts: { core: 0, active: 13, faded: 17, archived: 1 }, gist: false, body: false, deep: true, recent: false },
      ];
      for (const tc of cases) {
        fill(s, sess, tc.newer - written);
        written = tc.newer;
        const c = s.clock();
        const at = `${tc.newer} newer`;
        expect(tierOf(m, c), at).toBe(tc.tier);
        // The number of active memories settles at 13 however many are written.
        expect(s.tierCounts(c), at).toEqual(tc.counts);
        expect(search(s, "猫").length === 1, `${at}: gist word`).toBe(tc.gist);
        expect(search(s, "年糕").length === 1, `${at}: body word`).toBe(tc.body);
        expect(search(s, "年糕", true).length === 1, `${at}: deep`).toBe(tc.deep);
        expect(s.recent(c, 100).some((r) => r.id === id), `${at}: recent`).toBe(tc.recent);
      }

      // None of this wrote anything about the memory: its tier is read off the clock.
      expect(s.counts().events).toBe(2 + 31);
    }));

  it("ListingRestartsDecayWithoutStrengthening", () =>
    withStore((s) => {
      const sess = session(s, t0, "", "cli");
      const id = remember(s, t0, sess, "被搜到的事", "正文");
      fill(s, sess, 20);
      expect(tierOf(get(s, id), s.clock())).toBe("faded");

      listed(s, id);
      const m = get(s, id);
      expect(tierOf(m, 21)).toBe("active");
      expect(m.touchedOrd).toBe(21);
      near(m.fadeAt, 21 + fadeAfter, 1e-5);
      near(m.strength, 10, 1e-9);
      expect([m.readOrd, m.recallCount]).toEqual([1, 1]);

      // However often a search turns it up, it grows no stronger.
      for (let i = 0; i < 5; i++) {
        fill(s, sess, 3);
        listed(s, id);
      }
      const after = get(s, id);
      near(after.strength, 10, 1e-9);
      expect(after.recallCount).toBe(6);
      expect(tierOf(after, s.clock())).toBe("active");
    }));

  it("ReadingStrengthensByTheGapSinceTheLastReading", () =>
    withStore((s) => {
      const sess = session(s, t0, "", "cli");
      const soon = remember(s, t0, sess, "很快被读到的事", "正文一"); // ord 1
      const late = remember(s, t0, sess, "很久才被读到的事", "正文二"); // ord 2
      const idle = remember(s, t0, sess, "没人读的事", "正文三"); // ord 3

      fill(s, sess, 4); // clock 7
      read(s, soon); // 6 memories since it was written

      fill(s, sess, 15); // clock 22
      // The usual order: a search lists the memory, then it is read. The
      // listing in between must not eat the strengthening.
      listed(s, late);
      read(s, late); // 20 memories since it was written

      // S' = S * (1 + 2*(1 - R)), with R = exp(-n/10).
      const wantSoon = 10 * (1 + 2 * (1 - Math.exp(-0.6)));
      const wantLate = 10 * (1 + 2 * (1 - Math.exp(-2.0)));
      near(get(s, soon).strength, wantSoon, 1e-6);
      near(get(s, late).strength, wantLate, 1e-6);
      near(get(s, idle).strength, 10, 1e-9);
      const b = get(s, late);
      expect([b.readOrd, b.touchedOrd, b.recallCount]).toEqual([22, 22, 2]);
      near(b.fadeAt, 22 + wantLate * Math.log(1 / 0.3), 1e-5);

      // Reading it again straight away finds nothing to restore.
      read(s, late);
      const again = get(s, late);
      near(again.strength, wantLate, 1e-6);
      expect(again.recallCount).toBe(3);

      // A reading far in the future uses the strength the memory has by then.
      fill(s, sess, 40); // clock 62
      read(s, late);
      near(get(s, late).strength, wantLate * (1 + 2 * (1 - Math.exp(-40 / wantLate))), 1e-6);
    }));

  it("ArchivedMemoryComesBackWhenListed", () =>
    withStore((s) => {
      const sess = session(s, t0, "", "cli");
      const id = remember(s, t0, sess, "很久以前的事", "正文");
      fill(s, sess, 60);
      expect(tierOf(get(s, id), s.clock())).toBe("archived");
      listed(s, id, "m_gone"); // an id that names nothing is ignored
      const m = get(s, id);
      expect(tierOf(m, s.clock())).toBe("active");
      near(m.strength, 10, 1e-9);
    }));

  it("CoreMemoriesNeverFade", () =>
    withStore((s) => {
      const sess = session(s, t0, "", "cli");
      const important = rememberWith(s, { sessionId: sess, importance: 0.9, gist: "第一次被信任", body: "用户把整个项目交给了我。" });
      const felt = rememberWith(s, {
        sessionId: sess, importance: 0.3, intensity: 0.95, feeling: "很难忘", gist: "用户向我道别", body: "他说以后可能不再用了。",
      });
      const ordinary = rememberWith(s, {
        sessionId: sess, importance: 0.89, intensity: 0.89, feeling: "还好", gist: "差一点的事", body: "两项都没到门槛。",
      });

      fill(s, sess, 400);
      const far = s.clock();
      for (const id of [important, felt]) {
        const m = get(s, id);
        expect([m.core, tierOf(m, far), retentionOf(m, far), m.fadeAt, m.archiveAt]).toEqual([true, "core", 1, 0, 0]);
      }
      const o = get(s, ordinary);
      expect([o.core, tierOf(o, far)]).toEqual([false, "archived"]);
      // A core memory stays searchable by its details for good.
      expect(search(s, "整个项目")).toEqual([important]);
      const counts = s.tierCounts(far);
      expect(counts.core).toBe(2);
      expect(counts.archived).toBeGreaterThan(0);
      expect(tierTotal(counts)).toBe(403);
      const core = s.core(10);
      expect(core.length).toBe(2);
      expect(core[0]!.id).toBe(important);

      // Reading a core memory counts, and leaves it core.
      read(s, important);
      const m = get(s, important);
      expect([m.core, m.recallCount, m.fadeAt]).toEqual([true, 1, 0]);
    }));

  // In Go the parameters were server flags and a reopen with others replayed
  // the log. Here they are set on the memory; setting them replays the log,
  // and they stay with it across a restart of the object.
  it("ChangingParamsReplaysTheLog", async () => {
    const stub = freshObject();
    const [id, big] = await inObject(stub, (s) => {
      s.setParams(testParams());
      const sess = session(s, t0, "", "cli");
      const id = remember(s, t0, sess, "同一段记忆", "参数变了，它跟着变。");
      const big = rememberWith(s, { sessionId: sess, importance: 0.8, gist: "比较重要的事", body: "正文" });
      fill(s, sess, 5);
      read(s, id);
      expect(get(s, id).strength).toBeGreaterThan(10);
      s.setParams({ ...testParams(), baseStrength: 20, recallBoost: 0, coreImportance: 0.8 });
      return [id, big];
    });
    await evictDurableObject(stub);
    await inObject(stub, (s) => {
      const after = get(s, id);
      near(after.strength, 20, 1e-9); // no boost
      expect([after.recallCount, after.readOrd]).toEqual([1, 7]);
      // Lowering the core threshold made the important memory core.
      expect(get(s, big).core).toBe(true);
      // The log itself must not change.
      expect(s.counts().events).toBe(9);
    });
  });

  it("ArchivedMemoriesLoseTheirVectors", () =>
    withStore((s) => {
      const sess = session(s, t0, "", "cli");
      const a = get(s, remember(s, t0, sess, "甲", "会被归档"));
      const b = get(s, remember(s, t0, sess, "乙", "会被归档后又被想起"));
      const c = get(s, rememberWith(s, { sessionId: sess, importance: 0.95, gist: "丙", body: "核心记忆" }));
      const x = { model: "model-x", dims: 2 };
      const y = { model: "model-y", dims: 2 };
      for (const label of [y, x]) expect(s.saveVectors(label, [a, b, c].map((m) => ({ n: m.n, vec: [0.6, 0.8] })))).toBe(3);

      fill(s, sess, 20);
      // Nothing archived yet. Tending model-x drops model-y's vectors.
      expect(s.tendVectors(x).dropped).toBe(0);
      expect(s.vectorFigures(x).held).toEqual([{ model: "model-x", dims: 2, count: 3 }]);
      fill(s, sess, 20);
      // The two archived memories, once each.
      expect(s.tendVectors(x).dropped).toBe(2);
      expect(s.storedVectorNs()).toEqual([c.n]);

      // Archived memories do not wait for a vector. One that comes back does.
      const queued = () => new Set(s.tendVectors(x).waiting);
      expect(queued().has(a.n) || queued().has(b.n)).toBe(false);
      listed(s, b.id);
      const q = queued();
      expect([q.has(a.n), q.has(b.n)]).toEqual([false, true]);
    }));

  // The wall clock plays no part: the same events at any times give the same
  // forgetting state.
  it("ForgettingIgnoresTheWallClock", async () => {
    const state = (step: number) =>
      withStore((s) => {
        let at = t0;
        const sess = session(s, at, "", "cli");
        const ids: string[] = [];
        for (let i = 0; i < 20; i++) {
          at += step;
          const r = s.remember(at, {
            sessionId: sess, moment: "other", source: "lived", importance: 0.5,
            gist: "事 " + String.fromCharCode(97 + i), body: "正文",
          });
          ids.push(r.id);
        }
        at += step;
        s.logRecalls([{ at, read: true, ids: ids.slice(0, 3) }]);
        return ids.flatMap((id) => {
          const m: Memory = get(s, id);
          return [m.strength, m.fadeAt, m.archiveAt, m.touchedOrd];
        });
      });
    expect(await state(1000)).toEqual(await state(20 * 365 * 24 * 3600 * 1000));
  });

  // A note says at which point its memories came to mind. It is logged a
  // little later, and what was written in between must not count as having
  // lain between.
  it("ComingToMindIsDatedByItsOwnClock", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "", "cli");
      const id = remember(s, t0, sess, "读到的事", "正文");
      fill(s, sess, 5); // clock 6: here it is read
      fill(s, sess, 10); // clock 16: here the note is logged
      const note = (n: { read?: boolean; clock?: number }): Memory => {
        s.logRecalls([{ at: t0, ids: [id], ...n }]);
        return get(s, id);
      };

      const want = 10 * (1 + 2 * (1 - Math.exp(-0.5))); // five memories lay between, not fifteen
      let m = note({ read: true, clock: 6 });
      near(m.strength, want, 1e-6);
      expect([m.touchedOrd, m.readOrd]).toEqual([6, 6]);
      near(m.fadeAt, 6 + want * Math.log(1 / 0.3), 1e-5);

      // Notes from before that, arriving late, move nothing backwards.
      note({ read: true, clock: 3 });
      m = note({ clock: 2 });
      near(m.strength, want, 1e-6);
      expect([m.touchedOrd, m.readOrd, m.recallCount]).toEqual([6, 6, 3]);

      // A note cannot be dated in the future, and one without a date means now.
      m = note({ clock: 99 });
      expect(m.touchedOrd).toBe(16);
      near(m.strength, want, 1e-6);
      fill(s, sess, 2);
      expect(note({}).touchedOrd).toBe(18);

      // The dates are in the log: replaying it gives the same state.
      const before = dump(s, storage);
      s.rebuild();
      expect(dump(s, storage)).toBe(before);
    }));
});

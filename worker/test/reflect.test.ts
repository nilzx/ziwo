// Port of internal/store/reflect_test.go.

import { describe, expect, it } from "vitest";
import { AmendPin, AmendRestore, AmendRetract, AmendReweigh, AmendUnpin } from "../src/store/amend";
import {
  KindEpisode,
  KindImpression,
  KindLesson,
  KindReading,
  KindSelf,
  SourceReconstructed,
  StateAbsorbed,
  StateSuperseded,
} from "../src/store/content";
import { tierOf, tierTotal } from "../src/store/decay";
import { EntryError, NoBatchError, NoSessionError, ReflectBusyError } from "../src/store/errors";
import { isLive } from "../src/store/types";
import { amend, begin, ent, entry, hold, recentIDs, reflectOn, refused, replays, thrown } from "./amend-helpers";
import { fill, get, hour, listed, minute, near, remember, rememberWith, search, session, t0, withStore } from "./helpers";

const archiveAfter = 29.957323; // Go's decay_test.go: 10 * ln(20)
const day = 24 * hour;

describe("reflect", () => {
  it("ReflectPutsFragmentsTogether", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "", "cli");
      const f1 = remember(s, t0, sess, "用户让我做一个记忆系统", "一开始我理解成了项目笔记本 alphadetail。");
      const f2 = remember(s, t0, sess, "用户纠正了我的理解", "他说要记的是经历。");
      const f3 = remember(s, t0, sess, "设计定下来了", "用户说这正是他想要的。");
      const alone = remember(s, t0, sess, "用户问了天气", "聊了几句。");
      expect(s.pendingCount()).toBe(4);

      const episode = ent(KindEpisode, "我和用户一起把记忆系统的方向定了下来", f1, f2, f3);
      const impression = { ...ent(KindImpression, "说话直接，纠正时会讲原因", f2), about: "用户" };
      const ids = reflectOn(s, sess, [episode, ent(KindLesson, "设计类需求先问清它记什么", f1, f2), impression], alone);
      const [e, l, i] = [get(s, ids[0]!), get(s, ids[1]!), get(s, ids[2]!)];

      // Reflecting adds nothing to what was lived through.
      expect(s.clock(), "reflecting must not push memories away").toBe(4);
      // An account outlasts the moments it was made from; a lesson lasts longest.
      expect([e.kind, e.ord, e.pending, e.source, l.kind, i.kind, i.about])
        .toEqual([KindEpisode, 4, false, "lived", KindLesson, KindImpression, "用户"]);
      near(e.strength, 20, 1e-9);
      near(l.strength, 40, 1e-9);
      near(i.strength, 30, 1e-9);
      expect(s.sources(e.id)).toEqual([f1, f2, f3]);
      // The fragments are part of the episode now. They stay in the record and
      // leave ordinary recall.
      for (const f of [f1, f2, f3]) {
        const m = get(s, f);
        expect([m.state, m.stateBy, m.pending, m.body !== ""]).toEqual([StateAbsorbed, e.id, false, true]);
      }
      expect(search(s, "alphadetail")).toEqual([]);
      expect(search(s, "alphadetail", true)).toEqual([f1]);
      const recent = recentIDs(s);
      expect(recent).toHaveLength(4);
      expect(recent).not.toContain(f1);
      expect(recent).toEqual(expect.arrayContaining([e.id, alone]));
      expect(tierTotal(s.tierCounts(4))).toBe(4);

      // The fragment that was passed over has been dealt with. It leaves
      // ordinary recall after half the base strength, unless it comes to mind.
      const a = get(s, alone);
      expect([a.pending, isLive(a), a.fadeAt, a.archiveAt]).toEqual([false, true, 9, 9]);
      expect(s.pendingCount()).toBe(0);
      replays(s, storage);

      const other = remember(s, t0, sess, "又一件小事", "正文");
      reflectOn(s, sess, [], other);
      fill(s, sess, 4);
      listed(s, other);
      fill(s, sess, 1);
      const now = s.clock(); // 10
      const b = get(s, other);
      expect([tierOf(get(s, alone), now), tierOf(b, now)]).toEqual(["archived", "active"]);
      near(b.archiveAt, 9 + archiveAfter, 1e-5);
      replays(s, storage);
    }));

  it("ReflectIsAllOrNothing", () =>
    withStore((s) => {
      const sess = session(s, t0, "", "cli");
      const f1 = remember(s, t0, sess, "第一件事", "正文");
      const f2 = remember(s, t0, sess, "第二件事", "正文");
      const batch = begin(s, sess);

      const err = thrown(() =>
        s.finishReflect(t0, sess, batch, [ent(KindEpisode, "合起来的经历", f1, f2), ent(KindLesson, "一条经验", "m_nothing")], []),
      );
      expect(err).toBeInstanceOf(EntryError);
      expect((err as EntryError).index).toBe(1);
      expect(err.message).toContain("entry 2");
      expect(err.message).toContain("m_nothing");
      expect([s.counts().memories, get(s, f1).pending], "a refused round changed the memory").toEqual([2, true]);
      // The round is still open: the same batch can be written back once it is right.
      s.finishReflect(t0, sess, batch, [ent(KindEpisode, "合起来的经历", f1, f2)], []);
      // And then it is closed.
      expect(thrown(() => s.finishReflect(t0, sess, batch, [], [f1]))).toBeInstanceOf(NoBatchError);
    }));

  it("OneRoundOfReflectionAtATime", () =>
    withStore((s, storage) => {
      const a = session(s, t0, "", "phone");
      const b = session(s, t0, "", "desktop");
      const f = remember(s, t0, a, "一件事", "正文");

      const first = s.beginReflect(t0, a, hold);
      // While it runs, another conversation cannot start one, and is told until when.
      const busy = thrown(() => s.beginReflect(t0 + 5 * minute, b, hold));
      expect(busy).toBeInstanceOf(ReflectBusyError);
      expect((busy as ReflectBusyError).until).toBe(t0 + hold);
      expect(thrown(() => s.finishReflect(t0, b, first, [], [f]))).toBeInstanceOf(NoBatchError);
      // The same conversation may start over; its earlier batch is void.
      const second = s.beginReflect(t0 + 6 * minute, a, hold);
      expect(second).not.toBe(first);
      expect(second).toMatch(/^b_[a-z2-9]{8}$/);
      expect(thrown(() => s.finishReflect(t0, a, first, [], [f]))).toBeInstanceOf(NoBatchError);
      // A round that is never written back runs out, and then another may start.
      const third = s.beginReflect(t0 + 6 * minute + hold + 1000, b, hold);
      expect(thrown(() => s.finishReflect(t0, a, second, [], [f]))).toBeInstanceOf(NoBatchError);
      s.finishReflect(t0, b, third, [], [f]);
      expect(thrown(() => s.beginReflect(t0, "s_nothing", hold))).toBeInstanceOf(NoSessionError);
      // A round is working state. It leaves nothing in the log but its result.
      const kinds = storage.sql.exec<{ kind: string }>(`SELECT kind FROM events ORDER BY seq`).toArray().map((r) => r.kind);
      expect(kinds.join(" ")).toBe("session session remember reflect");
    }));

  // Not in reflect_test.go: abandoning closes only the round named.
  it("AbandonReflect", () =>
    withStore((s) => {
      const a = session(s, t0, "", "phone");
      const b = session(s, t0, "", "desktop");
      const batch = s.beginReflect(t0, a, hold);
      s.abandonReflect(b, batch); // not b's round
      s.abandonReflect(a, "b_other");
      expect(thrown(() => s.beginReflect(t0, b, hold))).toBeInstanceOf(ReflectBusyError);
      s.abandonReflect(a, batch);
      s.beginReflect(t0, b, hold);
    }));

  // Not in reflect_test.go: the edges of what the Go code does.
  it("EdgesOfARound", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "", "cli");
      const other = session(s, t0, "", "web");
      const lived = remember(s, t0, sess, "亲历的事", "正文");
      const told = rememberWith(s, { sessionId: sess, source: "told", gist: "听说的事", body: "正文" });
      const told2 = rememberWith(s, { sessionId: sess, source: "told", gist: "又听说的事", body: "正文" });
      // What it rests on gives the source: one source if they agree, lived if not.
      const [mixed, hearsay] = reflectOn(s, sess, [ent(KindLesson, "经验一", told, lived), ent(KindLesson, "经验二", told, told2)]);
      expect([get(s, mixed!).source, get(s, hearsay!).source]).toEqual(["lived", "told"]);

      // A round holds until the moment it runs out, and not past it.
      s.beginReflect(t0, sess, hold);
      expect((thrown(() => s.beginReflect(t0 + hold - 1, other, hold)) as ReflectBusyError).until).toBe(t0 + hold);
      s.beginReflect(t0 + hold, other, hold);

      // A newer impression replaces the one before it even when that one was
      // set aside, as Go's match on what it is about does.
      const [older] = reflectOn(s, other, [{ ...ent(KindImpression, "印象一", told), about: "某人" }]);
      amend(s, sess, AmendRetract, older!);
      const [newer] = reflectOn(s, other, [{ ...ent(KindImpression, "印象二", told2), about: "某人" }]);
      expect([get(s, older!).state, get(s, older!).stateBy]).toEqual([StateSuperseded, newer]);

      // A fragment passed a second time keeps what the first pass gave it.
      reflectOn(s, other, [], lived);
      const reviewed = () => storage.sql.exec<{ r: number }>(`SELECT reviewed AS r FROM memories WHERE id = ?`, lived).one().r;
      const first = [reviewed(), get(s, lived).fadeAt];
      fill(s, sess, 3);
      reflectOn(s, other, [], lived);
      expect([reviewed(), get(s, lived).fadeAt]).toEqual(first);
    }));

  it("WhatAnEntryMayRestOn", () =>
    withStore((s) => {
      const sess = session(s, t0, "", "cli");
      const f1 = remember(s, t0, sess, "片段一", "正文");
      const f2 = remember(s, t0, sess, "片段二", "正文");
      const retracted = remember(s, t0, sess, "被撤销的片段", "正文");
      const erased = remember(s, t0, sess, "被删除的片段", "正文");
      const old = remember(s, t0, sess, "被更正的片段", "正文");
      amend(s, sess, AmendRetract, retracted);
      s.erase(t0, sess, erased, "");
      const fixed = s.correct(t0, old, { sessionId: sess, moment: "other", source: "lived", importance: 0.5, gist: "更正后的片段", body: "正文" });
      const ep = reflectOn(s, sess, [ent(KindEpisode, "一段经历", f1)])[0]!;

      const cases: [string, ReturnType<typeof ent>, string][] = [
        ["nothing to rest on", ent(KindLesson, "经验"), "from is required"],
        ["an unknown memory", ent(KindLesson, "经验", "m_nothing"), "names no memory"],
        ["a retracted memory", ent(KindLesson, "经验", retracted), "retracted"],
        ["an erased memory", ent(KindLesson, "经验", erased), "erased"],
        ["a replaced memory", ent(KindLesson, "经验", old), "build on the correction"],
        ["episode from an absorbed one", ent(KindEpisode, "经历", f1, f2), "not part of one yet"],
        ["episode from an episode", ent(KindEpisode, "经历", ep), "put together from fragments"],
        ["a reading of nothing", entry({ kind: KindReading, gist: "新的理解", ref: "m_nothing" }), "names no memory"],
        ["a reading of an erased memory", entry({ kind: KindReading, gist: "新的理解", ref: erased }), "erased"],
      ];
      for (const [name, e, want] of cases) expect(refused(s, sess, e), name).toContain(want);
      // The texts as Go writes them.
      expect(refused(s, sess, ent(KindLesson, "经验", "m_nothing"))).toBe("entry 1: m_nothing names no memory");
      expect(refused(s, sess, ent(KindLesson, "经验", erased))).toBe(`entry 1: ${erased} has been erased`);
      expect(refused(s, sess, ent(KindLesson, "经验", retracted))).toBe(`entry 1: ${retracted} has been retracted`);
      expect(refused(s, sess, ent(KindLesson, "经验", old))).toBe(`entry 1: ${old} has been replaced by a correction: build on the correction`);
      expect(refused(s, sess, ent(KindLesson, "经验", fixed, "m_nothing"))).toBe("entry 1: m_nothing names no memory");
      expect(refused(s, sess, ent(KindEpisode, "经历", f1))).toBe(
        `entry 1: ${f1} cannot go into an episode: an episode is put together from fragments that are not part of one yet`,
      );
      // A lesson may rest on an episode, on a fragment that is part of one,
      // and on a correction.
      const ids = reflectOn(s, sess, [ent(KindLesson, "经验", ep, f1, fixed)]);
      expect(s.sources(ids[0]!)).toHaveLength(3);
      // Nothing else does: what reflect wrote is no basis.
      expect(refused(s, sess, ent(KindLesson, "经验二", ids[0]!))).toBe(
        `entry 1: ${ids[0]} is a lesson: build on what was lived through, fragments and episodes`,
      );
    }));

  it("StatementsAboutOneself", () =>
    withStore((s, storage) => {
      const a = session(s, t0, "model-a", "cli");
      const b = session(s, t0, "model-a", "cli");
      const a1 = remember(s, t0, a, "我先问清了需求再动手", "正文");
      const a2 = remember(s, t0, a, "我又一次先问清了需求", "正文");
      const a3 = remember(s, t0, a, "我第三次先问清了需求", "正文");
      const b1 = remember(s, t0, b, "另一次对话里我也先问清了需求", "正文");
      const told = rememberWith(s, { sessionId: b, source: "told", gist: "用户说我做事很谨慎", body: "他的原话。" });
      const self = (gist: string, ref: string, ...from: string[]) =>
        entry({ kind: KindSelf, gist, context: "做设计的时候", importance: 0.5, from, ref });

      expect(refused(s, a, self("我动手前会先问清楚", "", a1, b1))).toContain("at least 3 experiences");
      expect(refused(s, a, self("我动手前会先问清楚", "", a1, a2, a3))).toContain("this rests on 3 from 1");
      expect(refused(s, a, self("我做事很谨慎", "", a1, b1, told))).toContain("told or inferred");
      expect(refused(s, a, self("我动手前会先问清楚", "", a1, a2, a3))).toBe(
        "entry 1: a statement about yourself needs at least 3 experiences from at least 2 separate occasions; " +
          "this rests on 3 from 1. Leave it until it has shown up more often",
      );

      const id = reflectOn(s, a, [self("我动手前会先问清楚", "", a1, a2, b1)])[0]!;
      const m = get(s, id);
      expect([m.kind, m.core, m.context, m.source, m.model, tierOf(m, 1000)])
        .toEqual([KindSelf, true, "做设计的时候", "lived", "model-a", "core"]);
      expect(s.selves().map((x) => x.id)).toEqual([id]);
      // It is loaded whole at the start of a session, not searched for or listed.
      expect(recentIDs(s)).not.toContain(id);
      expect(search(s, "动手前会先问清楚")).not.toContain(id);
      expect(search(s, "动手前会先问清楚", true)).not.toContain(id);
      expect(s.core(10)).toHaveLength(0);
      expect(tierTotal(s.tierCounts(s.clock()))).toBe(5);

      // Revising it takes new experiences, not the same ones again.
      expect(refused(s, b, self("我有时不问就动手", id, a1, a2, a3))).toContain("this adds 1");
      expect(refused(s, b, self("改写", a1, a3, b1))).toContain("not a statement about yourself");
      const c1 = remember(s, t0, b, "这次我没问就动手了，结果返工", "正文");
      const revised = reflectOn(s, b, [self("我多数时候先问清楚，赶时间时会跳过", id, a3, c1)])[0]!;
      const was = get(s, id);
      expect([was.state, was.stateBy, was.gist]).toEqual([StateSuperseded, revised, "我动手前会先问清楚"]);
      const now = get(s, revised);
      expect([now.ref, isLive(now)]).toEqual([id, true]);
      expect(s.selves().map((x) => x.id)).toEqual([revised]);
      replays(s, storage);
    }));

  it("SeparateOccasionsAreCountedThroughEpisodesAndRecords", () =>
    withStore((s) => {
      const a = session(s, t0, "", "cli");
      const b = session(s, t0, "", "cli");
      const p1 = remember(s, t0, a, "第一次对话的片段", "正文");
      const p2 = remember(s, t0, b, "第二次对话的片段", "正文");
      const x = remember(s, t0, a, "同一次对话的另一件事", "正文");
      const y = remember(s, t0, a, "同一次对话的第三件事", "正文");
      const ep = reflectOn(s, a, [ent(KindEpisode, "跨两次对话的一段经历", p1, p2)])[0]!;
      // The episode was written in one conversation, but it is made of two.
      reflectOn(s, a, [entry({ kind: KindSelf, gist: "我会把事情跟到底", importance: 0.5, from: [ep, x, y] })]);

      // What is reconstructed from records is all written in one conversation.
      // There the day it happened tells the occasions apart.
      const dayAgo = (n: number, gist: string) =>
        rememberWith(s, { sessionId: a, source: SourceReconstructed, gist, body: "正文", happened: t0 - n * day });
      const r1 = dayAgo(30, "旧记录一"), r2 = dayAgo(30, "旧记录二"), r3 = dayAgo(30, "旧记录三");
      expect(refused(s, a, entry({ kind: KindSelf, gist: "我一直如此", importance: 0.5, from: [r1, r2, r3] }))).toContain("from 1");
      const r4 = dayAgo(10, "旧记录四");
      reflectOn(s, a, [entry({ kind: KindSelf, gist: "我一直如此", importance: 0.5, from: [r1, r2, r4] })]);
    }));

  it("ImpressionsAndReadings", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "model-a", "cli");
      const f1 = remember(s, t0, sess, "用户第一次纠正我", "正文");
      const f2 = remember(s, t0, sess, "用户夸了我", "正文");
      const about = (gist: string, from: string) => ({ ...ent(KindImpression, gist, from), about: "用户" });
      const first = reflectOn(s, sess, [about("严格", f1)])[0]!;
      const second = reflectOn(s, sess, [about("严格，也不吝称赞", f2)])[0]!;
      // The newer impression takes the place of the older; both are kept.
      const was = get(s, first);
      expect([was.state, was.stateBy]).toEqual([StateSuperseded, second]);
      expect(s.impressions(["用户", "别人"]).map((m) => m.id)).toEqual([second]);
      // The event names what it replaced, by id.
      const payload = storage.sql
        .exec<{ payload: string }>(`SELECT payload FROM events WHERE kind = 'remember' ORDER BY seq DESC LIMIT 1`)
        .one().payload;
      expect(JSON.parse(payload).replaces).toEqual([first]);

      // A later understanding hangs on the memory and leaves it as it was.
      const later = session(s, t0 + hour, "model-b", "cli");
      const before = get(s, f1);
      const rid = reflectOn(s, later, [entry({ kind: KindReading, gist: "我现在不理解当时为什么没有先问", ref: f1, importance: 0.5 })])[0]!;
      const after = get(s, f1);
      expect({ ...after, pending: false }, "a reading changed the memory it reads").toEqual({ ...before, pending: false });
      const readings = s.readings(f1);
      expect(readings.map((r) => [r.id, r.model, r.ref, r.source])).toEqual([[rid, "model-b", f1, "inferred"]]);
      expect(recentIDs(s)).not.toContain(rid);
      expect(search(s, "不理解")).toEqual([]);
      replays(s, storage);
    }));
});

// Found while porting; Go behaves otherwise in both.
describe("what the port puts right", () => {
  it("a milestone and a statement about oneself stay core through any amendment", () =>
    withStore((s, storage) => {
      const a = session(s, t0, "", "cli");
      const b = session(s, t0 + hour, "", "cli");
      const f = [remember(s, t0, a, "一", "一"), remember(s, t0, a, "二", "二"), remember(s, t0 + hour, b, "三", "三")];
      const g = [remember(s, t0, a, "四", "四"), remember(s, t0 + hour, b, "五", "五")];
      const [ep, self] = reflectOn(s, a, [
        { ...ent(KindEpisode, "一件大事", g[0]!, g[1]!), milestone: true },
        ent(KindSelf, "我是这样的", ...f),
      ]);
      const core = (id: string): unknown[] => {
        const m = get(s, id);
        return [m.core, m.fadeAt, m.archiveAt, m.retracted, m.pinned];
      };
      for (const id of [ep!, self!]) {
        expect(core(id)).toEqual([true, 0, 0, false, false]);
        for (const action of [AmendRetract, AmendRestore, AmendPin, AmendUnpin]) amend(s, a, action, id);
        amend(s, a, AmendReweigh, id, 0.2);
        expect(core(id), id).toEqual([true, 0, 0, false, false]);
      }
      replays(s, storage);
    }));

  it("a reading is not linked to what does not exist", () =>
    withStore((s) => {
      const a = session(s, t0, "", "cli");
      const f = remember(s, t0, a, "一", "一");
      const other = remember(s, t0, a, "二", "二");
      const reading = (from: string[]) => ({ ...ent(KindReading, "现在看是另一回事"), ref: f, from });
      expect(refused(s, a, reading(["m_nothing"]))).toMatch(/^entry 1: m_nothing names no memory/);
      amend(s, a, AmendRetract, other);
      expect(refused(s, a, reading([other]))).toMatch(/has been retracted/);
      amend(s, a, AmendRestore, other);
      const [id] = reflectOn(s, a, [reading([other])]);
      expect(s.sources(id!)).toEqual([other]);
      expect(s.check().findings.filter((x) => x.level === "problem")).toEqual([]);
    }));
});

// Port of internal/memory/amend_test.go, through the object's methods. The
// tests whose subject is search by meaning run with the stand-in model of
// embed-helpers.ts; f.sync() runs what the alarm runs. The others hand in
// matches by meaning from the stand-in in service-helpers.ts, computed over
// the memories as they were before the change.

import { describe, expect, it } from "vitest";
import { AmendActions, goG, MaxEntries, MaxPreferences, MaxReasonRunes } from "../src/memory/amend";
import { MaxGistRunes, parseWhen } from "../src/memory/clean";
import type { AmendRequest, EntryRequest } from "../src/memory/amend";
import { KindEpisode, KindImpression, KindLesson, KindReading, StateAbsorbed, StateErased } from "../src/store/content";
import { tierTotal } from "../src/store/decay";
import { hour, minute } from "./helpers";
import { byMeaning, distinct, type Fixture, ids, isInvalid, ok, start, startEmbedded } from "./service-helpers";

function amend(f: Fixture, req: AmendRequest): string {
  return ok(f.obj.amend({ sessionId: f.sess(), ...req }), `amend ${req.action} ${req.id}`);
}

// refusedAmend returns the message of an amendment that must be turned down
// as a mistake the model can fix.
function refusedAmend(f: Fixture, req: AmendRequest): string {
  const r = f.obj.amend(req);
  if (!isInvalid(r)) expect.fail(`amend ${JSON.stringify(req)}: ${r}; want it refused as invalid input`);
  return r.invalid;
}

function invalidOf(x: unknown): string {
  if (!isInvalid(x)) expect.fail(`${JSON.stringify(x)}: want it refused as invalid input`);
  return x.invalid;
}

describe("amend through the service", () => {
  it("RetractAndEraseLeaveRecallAtOnce", () =>
    startEmbedded(async (f) => {
      const cat = f.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。");
      const kitten = f.remember("The kitten knocked over my notes", "Nothing else happened.");
      await f.sync();

      // Set aside: gone from recall by keyword and by meaning before any sweep.
      expect(amend(f, { action: "retract", id: cat, reason: "用户说这个不用记" })).toContain("restore");
      expect(ids(f.recall("feline"))).toEqual([kitten]);
      expect(ids(f.deepRecall("年糕"))).toEqual([]);
      // It can still be read by id, marked for what it is, and that is not a recall.
      const r = f.expand(cat);
      expect([r.retracted, r.body !== ""]).toEqual([true, true]);
      await f.sync();
      expect(f.get(cat).recallCount, "reading a retracted memory counted as coming to mind").toBe(0);

      amend(f, { action: "restore", id: cat });
      await f.sync();
      expect(f.recall("feline")).toHaveLength(2);

      // Erased: gone for good, from the vectors too, in the same call.
      const before = f.indexed();

      // Erased: gone for good. Asked of amend, it points at its own call.
      expect(refusedAmend(f, { sessionId: f.sess(), action: "erase", id: cat })).toBe(
        "erase is a tool of its own: call erase with the id of the memory",
      );
      expect(f.get(cat).state).toBe("");
      expect(ok(f.obj.erase({ sessionId: f.sess(), id: cat, reason: "用户让我删掉" }))).toBe(
        `erased ${cat}: what it said is gone for good. The record keeps only that it existed and that it was erased`,
      );
      expect(f.indexed()).toBe(before - 1);
      expect(ids(f.recall("feline"))).toEqual([kitten]);
      const e = f.expand(cat);
      expect([e.state, e.gist, e.body]).toEqual([StateErased, "", ""]);
      expect(refusedAmend(f, { sessionId: f.sess(), action: "pin", id: cat })).toBe(
        `${cat} has been erased; there is nothing left to amend`,
      );
    }));

  // Not in amend_test.go: erase keeps the checks amend made for it.
  it("EraseChecksWhatItIsAsked", () =>
    start((f) => {
      const id = f.remember("一件事", "正文");
      const cases: [Parameters<typeof f.obj.erase>[0], string][] = [
        [{ id }, "session_id is required: call get_context first and pass the session id it returns"],
        [{ sessionId: " s_nope ", id }, `unknown session_id "s_nope": call get_context and pass the session id it returns`],
        [{ sessionId: f.sess(), id: "  " }, "id is required for erase"],
        [{ sessionId: f.sess(), id, reason: "字".repeat(MaxReasonRunes + 1) }, `reason is ${MaxReasonRunes + 1} characters, the limit is ${MaxReasonRunes}`],
        [{ sessionId: f.sess(), id: "m_nothing" }, `no memory with id "m_nothing"`],
      ];
      for (const [args, want] of cases) expect(invalidOf(f.obj.erase(args)), JSON.stringify(args)).toBe(want);
      expect(f.get(id).state).toBe("");
      ok(f.obj.erase({ sessionId: f.sess(), id: ` ${id} ` }));
      expect(invalidOf(f.obj.erase({ sessionId: f.sess(), id }))).toBe(`${id} has been erased; there is nothing left to amend`);
      // The reason is kept in the log, trimmed; an empty one is left out.
      const reasons = f.storage.sql
        .exec<{ payload: string }>(`SELECT payload FROM events WHERE kind = 'erase'`)
        .toArray()
        .map((x) => JSON.parse(x.payload) as Record<string, unknown>);
      expect(reasons).toEqual([{ session: f.sess(), id }]);
    }));

  it("CorrectCarriesOverWhatWasNotWrong", () =>
    start((f) => {
      const old = f.rememberWith({
        gist: "用户的猫叫年糕", body: "一只橘猫，很亲人。", outcome: "聊得很开心", people: ["用户"], importance: 0.7,
        moment: "emotion", feeling: "喜欢", intensity: 0.4,
      });
      f.advance(72 * hour);

      const msg = amend(f, { action: "correct", id: old, gist: "用户的猫叫汤圆", reason: "用户说我记错了名字" });
      const rs = f.recall("橘猫");
      expect(rs).toHaveLength(1);
      const is = rs[0]!;
      expect(is.id).not.toBe(old);
      expect(msg).toBe(`corrected: ${is.id} now stands in place of ${old}, which stays in the record marked as replaced`);
      expect([is.gist, is.body, is.outcome, is.importance, is.moment, is.feeling, is.intensity, is.people, is.corrects])
        .toEqual(["用户的猫叫汤圆", "一只橘猫，很亲人。", "聊得很开心", 0.7, "emotion", "喜欢", 0.4, ["用户"], old]);
      // It is still a memory of the day it happened.
      const was = f.get(old);
      expect(is.createdAt).toBe(was.createdAt);
      expect(is.writtenAt).toBeGreaterThan(is.createdAt);
      expect(was.stateBy).toBe(is.id);
      expect(f.deepRecall("橘猫")).toHaveLength(2);

      const cases: [string, AmendRequest, string][] = [
        ["nothing to say instead", { action: "correct", id: is.id }, "what to say instead"],
        ["already replaced", { action: "correct", id: old, gist: "x" }, is.id],
        ["a gist that is too long", { action: "correct", id: is.id, gist: "字".repeat(MaxGistRunes + 1) }, "gist is"],
        ["unknown memory", { action: "retract", id: "m_nothing" }, "no memory with id"],
        ["unknown action", { action: "polish", id: is.id }, "action must be one of"],
        ["no id", { action: "pin" }, "id is required"],
        ["reweigh to nothing", { action: "reweigh", id: is.id }, "importance is required"],
        ["reweigh out of range", { action: "reweigh", id: is.id, importance: 1.5 }, "importance is required"],
        ["a reason that is a text", { action: "pin", id: is.id, reason: "字".repeat(MaxReasonRunes + 1) }, "reason is"],
        ["prefer without a rule", { action: "prefer" }, "text is required"],
        ["unprefer of nothing", { action: "unprefer", id: "p_nothing" }, "no preference in force"],
      ];
      for (const [name, req, want] of cases) {
        expect(refusedAmend(f, { ...req, sessionId: f.sess() }), name).toContain(want);
      }
      for (const [name, sessionId] of [["no session", ""], ["unknown session", "s_nope"]] as const) {
        expect(refusedAmend(f, { sessionId, action: "pin", id: is.id }), name).toContain("get_context");
      }
      expect(f.get(is.id).pinned, "a refused amendment took effect").toBe(false);

      // The texts as Go writes them.
      const s = f.sess();
      expect(refusedAmend(f, { sessionId: s, action: "correct", id: is.id })).toBe(
        "correct needs what to say instead: give gist, body, outcome or lesson, whichever was wrong",
      );
      expect(refusedAmend(f, { sessionId: s, action: "pin", id: old })).toBe(
        `${old} has been replaced by a correction (${is.id}): amend that one`,
      );
      expect(refusedAmend(f, { sessionId: s, action: "polish", id: is.id })).toBe(
        "action must be one of retract, restore, pin, unpin, reweigh, correct, prefer, unprefer",
      );
      expect(AmendActions).not.toContain("erase");
      expect(refusedAmend(f, { sessionId: s, action: "pin" })).toBe("id is required for pin");
      expect(refusedAmend(f, { sessionId: s, action: "reweigh", id: is.id, importance: 0 })).toBe(
        "importance is required for reweigh, above 0 and at most 1",
      );
      expect(refusedAmend(f, { sessionId: s, action: "unprefer", id: "p_nothing" })).toBe(`no preference in force with id "p_nothing"`);
      expect(refusedAmend(f, { sessionId: s, action: "retract", id: "m_nothing" })).toBe(`no memory with id "m_nothing"`);
    }));

  // Not in amend_test.go: the other sentences, and what correct refuses.
  it("AmendSaysWhatWasDone", () =>
    start((f) => {
      const id = f.remember("一件事", "正文");
      expect(amend(f, { action: "pin", id })).toBe(`pinned ${id}: it will not fade`);
      expect(amend(f, { action: "unpin", id })).toBe(`unpinned ${id}: it fades like any other memory from here on`);
      expect(amend(f, { action: "retract", id: ` ${id} ` })).toBe(
        `retracted ${id}: it stays in the record and will not be recalled. restore undoes this`,
      );
      expect(amend(f, { action: " restore ", id })).toBe(`restored ${id}: it can be recalled again`);
      expect(amend(f, { action: "reweigh", id, importance: 0.25 })).toBe(`importance of ${id} is now 0.25`);
      expect(amend(f, { action: "reweigh", id, importance: 0.125 })).toBe(`importance of ${id} is now 0.12`);
      expect(f.get(id).importance).toBe(0.125);
      // A statement about oneself is not corrected this way.
      const v = ok(f.obj.beginReflect({ sessionId: f.sess() }));
      const [imp] = ok(f.obj.finishReflect({
        sessionId: f.sess(), batch: v.batch, entries: [{ kind: KindImpression, gist: "印象", about: "某人", from: [id] }],
      }));
      expect(refusedAmend(f, { sessionId: f.sess(), action: "correct", id: imp!, gist: "x" })).toBe(
        `${imp} is a impression: only fragments, episodes and lessons are corrected this way`,
      );
      // A lesson is, and stays a lesson.
      const v2 = ok(f.obj.beginReflect({ sessionId: f.sess() }));
      const [lesson] = ok(f.obj.finishReflect({
        sessionId: f.sess(), batch: v2.batch, entries: [{ kind: KindLesson, gist: "经验", body: "正文", from: [id] }],
      }));
      // A field that is only blank keeps what the old memory said.
      const said = amend(f, { action: "correct", id: lesson!, gist: "  ", body: "新的正文" });
      const fixed = said.split(" ")[1]!;
      expect([f.get(fixed).kind, f.get(fixed).gist, f.get(fixed).body, f.get(lesson!).stateBy]).toEqual([KindLesson, "经验", "新的正文", fixed]);
    }));

  it("PreferencesAreLoadedWithTheContext", () =>
    start((f) => {
      const msg = amend(f, { action: "prefer", text: "  不用记天气之类的闲聊  ", reason: "用户说的" });
      let view = f.begin("model-a", "cli");
      expect(view.prefs.map((p) => p.text)).toEqual(["不用记天气之类的闲聊"]);
      expect(msg).toBe(`preference saved as ${view.prefs[0]!.id}; get_context will show it from now on`);
      expect(amend(f, { action: "unprefer", id: view.prefs[0]!.id })).toBe(`preference ${view.prefs[0]!.id} dropped`);
      view = f.begin("model-a", "cli");
      expect(view.prefs).toEqual([]);
      for (const x of distinct(MaxPreferences)) amend(f, { action: "prefer", text: "规则 " + x });
      expect(refusedAmend(f, { sessionId: f.sess(), action: "prefer", text: "再来一条" })).toBe(
        `there are already ${MaxPreferences} preferences in force: drop one with unprefer, or fold this into an existing one`,
      );
      expect(refusedAmend(f, { sessionId: f.sess(), action: "prefer", text: "字".repeat(301) })).toBe(
        "text is 301 characters, the limit is 300: a preference is a short rule",
      );
    }));

  it("ReconstructedMemoriesNeedADate", () =>
    start((f) => {
      f.fill(3);
      const sixMonthsBefore = (ms: number) => {
        const d = new Date(ms);
        d.setUTCMonth(d.getUTCMonth() - 6);
        return d.getTime();
      };
      const past = sixMonthsBefore(f.clock);
      const iso = (ms: number) => new Date(ms).toISOString();
      const base = { sessionId: f.sess(), gist: "半年前和用户做的一个项目", body: "从旧会话记录里整理出来的。", pointer: "~/.claude/projects/x/abc.jsonl" };
      const cases: [string, string, string | undefined, string][] = [
        ["no date", "reconstructed", undefined, "happened_at is required"],
        ["a date in the future", "reconstructed", iso(f.clock + 48 * hour), "in the future"],
        ["a date on a lived memory", "lived", iso(past), "goes with source"],
        ["a date on a told memory", "told", iso(past), "goes with source"],
      ];
      for (const [name, source, happenedAt, want] of cases) {
        expect(invalidOf(f.obj.remember({ ...base, source, happenedAt })), name).toContain(want);
      }
      const { id } = ok(f.obj.remember({ ...base, source: "reconstructed", happenedAt: iso(past) }));
      const m = f.get(id);
      expect([m.createdAt, m.writtenAt, m.source, f.lived(), f.tier(id)]).toEqual([past, f.clock, "reconstructed", 3, "active"]);
      expect(ids(f.recall("半年前"))).toEqual([id]);

      const day = Date.UTC(2026, 2, 14);
      expect(parseWhen("2026-03-14")).toBe(day);
      expect(parseWhen(" 2026-03-14T09:30:00+08:00 ")).toBe(day + 1.5 * hour);
      expect(parseWhen("2026-03-14 09:30")).toBe(day + 9.5 * hour);
      expect(() => parseWhen("last spring")).toThrow(/cannot read/);
    }));
});

describe("reflect through the service", () => {
  it("ReflectThroughTheService", () =>
    start((f) => {
      const a = f.sess();
      const f1 = f.rememberWith({ gist: "用户让我做一个记忆系统", body: "一开始我理解成了项目笔记本。", people: ["用户"] });
      const f2 = f.remember("用户纠正了我的理解", "他说要记的是经历。");
      const f3 = f.remember("用户问了天气", "聊了几句。");
      const b = f.begin("model-a", "desktop").session.id;

      const before = f.begin("model-a", "cli");
      expect([before.pending, before.selves.length]).toEqual([3, 0]);
      const view = ok(f.obj.beginReflect({ sessionId: a, limit: 2 }));
      expect([view.batch !== "", view.fragments.length, view.remaining, view.fragments[0]!.body !== ""]).toEqual([true, 2, 1, true]);
      expect(view.fragments.map((m) => m.id)).toEqual([f1, f2]);
      // One round at a time, and the other conversation is told why and for how long.
      expect(invalidOf(f.obj.beginReflect({ sessionId: b }))).toBe(
        "another conversation is reflecting right now, so that the same fragments are not put together twice. " +
          "Its round runs out in 15 min at the latest; try again then",
      );
      f.advance(5 * minute + 1);
      expect(invalidOf(f.obj.beginReflect({ sessionId: b }))).toContain("runs out in 10 min");
      f.advance(-5 * minute - 1);

      const episode: EntryRequest = {
        kind: KindEpisode, gist: "我和用户把记忆系统的方向定了下来", body: "先理解偏了，被纠正后改了设计。", from: [f1, f2], milestone: true,
      };
      const finish = (entries: EntryRequest[], pass: string[] = [], batch = view.batch) =>
        f.obj.finishReflect({ sessionId: a, batch, entries, pass });
      const cases: [string, EntryRequest[], string][] = [
        ["an unknown kind", [{ kind: "dream", gist: "g" }], "kind must be one of"],
        ["an episode without a body", [{ kind: KindEpisode, gist: "g", from: [f1] }], "body is required"],
        ["an impression of nobody", [{ kind: KindImpression, gist: "g", from: [f1] }], "about is required"],
        ["a reading of nothing", [{ kind: KindReading, gist: "g" }], "ref is required"],
        ["a feeling made up", [{ kind: KindLesson, gist: "g", body: "b", from: [f1], intensity: 0.8 }], "needs a feeling"],
        ["too many entries", Array.from({ length: MaxEntries + 1 }, () => ({})), "at most"],
        ["resting on nothing known", [episode, { kind: KindLesson, gist: "g", body: "b", from: ["m_nothing"] }], "entry 2"],
        ["nothing at all", [], "nothing to write back"],
      ];
      for (const [name, entries, want] of cases) expect(invalidOf(finish(entries)), name).toContain(want);
      expect(invalidOf(finish([episode], [], "b_nothing"))).toContain("is not open");
      expect(f.get(f1).state, "a refused round changed the memory").toBe("");

      // The texts as Go writes them.
      expect(invalidOf(finish([{ kind: "dream", gist: "g" }]))).toBe(
        "kind must be one of episode, lesson, impression, self, reading (entry 1)",
      );
      expect(invalidOf(finish([episode, { kind: KindEpisode, gist: "g", from: [f1] }]))).toBe("body is required for episode (entry 2)");
      expect(invalidOf(finish([episode, { kind: KindLesson, gist: "g", body: "b", from: ["m_nothing"] }]))).toBe(
        "entry 2: m_nothing names no memory. Nothing was written",
      );
      expect(invalidOf(finish([episode], [], " b_nothing "))).toBe(
        `batch "b_nothing" is not open: it was already written back, or its round ran out and another conversation started one. ` +
          "Nothing was written. Call reflect without a batch to start again",
      );
      expect(invalidOf(finish([{ kind: KindLesson, gist: "g", body: "b", context: "字".repeat(201), from: [f1] }]))).toBe(
        "context is 201 characters, the limit is 200: name the situation, do not describe it (entry 1)",
      );
      expect(invalidOf(finish([{ kind: KindLesson, gist: "g", body: "b", from: distinct(21) }]))).toBe("at most 20 ids in from (entry 1)");
      expect(invalidOf(f.obj.finishReflect({ sessionId: " ", batch: view.batch, pass: [f3] }))).toBe(
        "session_id is required: call get_context first and pass the session id it returns",
      );

      const made = ok(finish([episode], [f3, " "]));
      expect(made).toHaveLength(1);
      // The ids passed are trimmed, and the empty ones left out.
      const passed = f.storage.sql.exec<{ p: string }>(`SELECT json_extract(payload, '$.passed') AS p FROM events WHERE kind = 'reflect'`).one().p;
      expect(JSON.parse(passed)).toEqual([f3]);
      const ep = f.expand(made[0]!);
      expect([ep.kind, ep.milestone, ep.core, ep.sources, ep.importance]).toEqual([KindEpisode, true, true, [f1, f2], 0.5]);
      const r = f.expand(f1);
      expect([r.state, r.stateBy]).toEqual([StateAbsorbed, made[0]]);
      const after = f.begin("model-a", "cli");
      expect([after.pending, after.core.map((m) => m.id), tierTotal(after.counts)]).toEqual([0, [made[0]], 2]);
      // The round is over, so the other conversation may start one. There is
      // nothing left to reflect on, and so no batch.
      const empty = ok(f.obj.beginReflect({ sessionId: b }));
      expect([empty.batch, empty.fragments]).toEqual(["", []]);
      expect(invalidOf(f.obj.beginReflect({ sessionId: "s_nope" }))).toBe(
        `unknown session_id "s_nope": call get_context and pass the session id it returns`,
      );

      // A later understanding is shown with the memory it reads.
      f.remember("又过了一阵", "正文");
      const v2 = ok(f.obj.beginReflect({ sessionId: b }));
      ok(f.obj.finishReflect({
        sessionId: b, batch: v2.batch, entries: [{ kind: KindReading, gist: "现在看，当时的误解来自我没有先问", ref: made[0] }],
      }));
      const read = f.expand(made[0]!);
      expect(read.readings.map((m) => m.ref)).toEqual([made[0]]);
    }));

  // Not in amend_test.go: an entry keeps only the fields its kind has.
  it("AnEntryKeepsOnlyWhatItsKindHas", () =>
    start((f) => {
      const x = f.remember("一件事", "正文");
      const extra = { about: " 某人 ", context: " 某种场合 ", ref: x, milestone: true };
      const v = ok(f.obj.beginReflect({ sessionId: f.sess() }));
      const [lesson, impression] = ok(f.obj.finishReflect({
        sessionId: f.sess(), batch: v.batch, entries: [
          { kind: KindLesson, gist: "经验", body: "正文", from: [x], ...extra },
          { kind: KindImpression, gist: "印象", from: [x], ...extra },
        ],
      }));
      const fields = (id: string) => {
        const m = f.get(id);
        return [m.about, m.context, m.ref, m.milestone];
      };
      expect([fields(lesson!), fields(impression!)]).toEqual([["", "", "", false], ["某人", "", "", false]]);
    }));

  // Not in amend_test.go: what a batch is handed besides the fragments.
  it("ABatchCarriesSelvesAndImpressions", () =>
    start((f) => {
      const x1 = f.rememberWith({ gist: "和阿明的第一次", body: "正文", people: ["阿明"] });
      const v1 = ok(f.obj.beginReflect({ sessionId: f.sess() }));
      const [imp] = ok(f.obj.finishReflect({
        sessionId: f.sess(), batch: v1.batch, entries: [{ kind: KindImpression, gist: "阿明很细心", about: "阿明", from: [x1] }], pass: [x1],
      }));
      f.rememberWith({ gist: "和阿明的第二次", body: "正文", people: ["阿明", "小红"] });
      f.rememberWith({ gist: "和小红的一次", body: "正文", people: ["小红"] });
      const v2 = ok(f.obj.beginReflect({ sessionId: f.sess(), limit: 50 }));
      expect([v2.fragments.length, v2.remaining, v2.impressions.map((m) => m.id), v2.selves]).toEqual([2, 0, [imp], []]);
    }));

  // The vectors of fragments that went into an episode are dropped by the
  // next sweep. Until then they must not bring the fragments back.
  it("AbsorbedFragmentsLeaveRecallByMeaningAtOnce", () =>
    startEmbedded(async (f) => {
      const a = f.remember("用户给我看了他的猫", "一只橘猫。");
      const b = f.remember("The kitten knocked over my notes", "Nothing else happened.");
      await f.sync();
      const view = ok(f.obj.beginReflect({ sessionId: f.sess() }));
      const made = ok(f.obj.finishReflect({
        sessionId: f.sess(), batch: view.batch,
        entries: [{ kind: KindEpisode, gist: "和用户的猫相处的一个下午", body: "先看了照片，后来它打翻了我的笔记。", from: [a, b] }],
      }));
      expect(f.indexed(), "the fragments' vectors are there until the sweep").toBe(2);
      for (const r of f.recall("feline")) {
        expect([a, b], "an absorbed fragment came back through its vector").not.toContain(r.id);
      }
      await f.sync();
      const rs = f.recall("feline");
      expect(rs.map((r) => [r.id, r.byMeaning])).toEqual([[made[0], true]]);
      expect(f.indexed(), "only the episode").toBe(1);
    }));

  // Not in amend_test.go: a retracted memory is shown by no search, deep or
  // not, by keyword or by meaning, until it is restored.
  it("ARetractedMemoryIsNotShownByADeepSearch", () =>
    start((f) => {
      const cat = f.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。");
      const other = f.remember("另一只猫", "也是橘色的。");
      const indexed = f.st.get([cat, other]);
      f.fill(40); // both archived: only a deep search reaches them
      amend(f, { action: "retract", id: cat });
      expect(ids(f.recall("年糕"))).toEqual([]);
      expect(ids(f.deepRecall("年糕"))).toEqual([]);
      expect(ids(f.deepRecall("橘猫", byMeaning("cat", indexed)))).toEqual([other]);
      amend(f, { action: "restore", id: cat });
      // Restored, it came to mind: active again, found by an ordinary search.
      expect(ids(f.recall("年糕"))).toEqual([cat]);
    }));
});

describe("goG", () => {
  // Produced by Go's fmt.Sprintf("%.2g", x).
  it("is Go's %.2g", () => {
    const want: Record<string, string> = {
      "0.0001": "0.0001", "0.00012": "0.00012", "0.01": "0.01", "0.015": "0.015", "0.025": "0.025", "0.035": "0.035",
      "0.05": "0.05", "0.0625": "0.062", "0.1": "0.1", "0.125": "0.12", "0.135": "0.14", "0.15": "0.15", "0.25": "0.25",
      "0.333333": "0.33", "0.375": "0.38", "0.45": "0.45", "0.5": "0.5", "0.55": "0.55", "0.625": "0.62", "0.65": "0.65",
      "0.7": "0.7", "0.75": "0.75", "0.85": "0.85", "0.875": "0.88", "0.9": "0.9", "0.95": "0.95", "0.995": "0.99",
      "0.999": "1", "1": "1", "1.25e-05": "1.3e-05", "1.5e-05": "1.5e-05", "1e-05": "1e-05", "1e-07": "1e-07",
      "2.5e-05": "2.5e-05", "9.999e-05": "0.0001", "9.9e-05": "9.9e-05",
    };
    for (const [x, s] of Object.entries(want)) expect(goG(Number(x), 2), x).toBe(s);
  });
});

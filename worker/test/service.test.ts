// Port of internal/memory/service_test.go. A listing or a reading is logged
// in the call that made it, so what Go checks after f.sync() for those is
// checked at once here. Search by meaning runs in the object with the
// stand-in model of embed-helpers.ts: f.sync() runs what the alarm runs.

import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MaxBodyRunes, MaxExpand, MaxFieldRunes, MaxGistRunes, MaxPeople } from "../src/memory/clean";
import type { RememberArgs } from "../src/memory-object";
import { TopicEmbedder } from "./embed-helpers";
import { freshObject, minute, hour, t0 } from "./helpers";
import { distinct, ids, isInvalid, reopen, start, startEmbedded } from "./service-helpers";

describe("service", () => {
  it("RecallByKeywordAndByMeaning", () =>
    startEmbedded(async (f) => {
      const cat = f.remember("用户给我看了他的猫", "一只橘猫，叫年糕。");
      const deploy = f.remember("第一次部署出了问题", "反向代理拒绝了所有请求。");
      f.remember("用户问了天气", "聊了几句就结束了。");
      await f.sync();
      expect(f.indexed()).toBe(3);

      // No word in common with the memory: only the meaning can find it.
      let rs = f.recall("feline");
      expect(rs.map((r) => [r.id, r.byKeyword, r.byMeaning])).toEqual([[cat, false, true]]);

      // A word in the body that the stand-in model knows nothing about: only
      // the keyword index can find it.
      rs = f.recall("反向代理");
      expect(rs.map((r) => [r.id, r.byKeyword, r.byMeaning])).toEqual([[deploy, true, false]]);

      // Found both ways: counted once.
      rs = f.recall("部署");
      expect(rs.map((r) => [r.id, r.byKeyword, r.byMeaning])).toEqual([[deploy, true, true]]);

      expect(ids(f.recall("量子力学"))).toEqual([]);
    }));

  it("RecallRanksAgreementAboveASingleSignal", () =>
    startEmbedded(async (f) => {
      const meaningOnly = f.remember("The kitten knocked over my notes", "Nothing else happened.");
      const both = f.remember("用户的猫生病了", "他很担心，我陪他查了资料。");
      await f.sync();
      expect(ids(f.recall("猫"))).toEqual([both, meaningOnly]);
    }));

  it("ImportanceBreaksTies", () =>
    start((f) => {
      const minor = f.rememberWith({ gist: "小事：一样的正文", body: "一样的正文", importance: 0.4 });
      const major = f.rememberWith({ gist: "大事：一样的正文", body: "一样的正文", importance: 0.85 });
      // Keyword rank puts one of them first by a hair; importance has to outweigh that.
      expect(ids(f.recall("一样的正文"))).toEqual([major, minor]);
    }));

  // With the model down, the Worker hands the object no query vector (see
  // meaning.test.ts for the Worker's side) and the object cannot embed.
  it("RecallFallsBackToKeywordsWhenEmbeddingFails", () => {
    const emb = new TopicEmbedder();
    return startEmbedded(async (f) => {
      const deploy = f.remember("第一次部署出了问题", "反向代理拒绝了所有请求。");
      await f.sync();

      emb.down = true;
      const rs = f.recall("部署");
      expect(rs.map((r) => [r.id, r.byKeyword, r.byMeaning])).toEqual([[deploy, true, false]]);
      // An empty answer by meaning counts as no way that found anything.
      const again = f.recall("部署", []);
      expect(again.map((r) => [r.id, r.byKeyword, r.byMeaning, r.score])).toEqual([[deploy, true, false, rs[0]!.score]]);

      // A memory written while the embedder is down is searchable by keyword
      // at once, and by meaning once the embedder is back.
      const cat = f.remember("用户给我看了他的猫", "一只橘猫。");
      expect(ids(f.recall("橘猫"))).toEqual([cat]);
      expect((await f.obj.embedOnce()).failed).toBe(true);
      emb.down = false;
      await f.sync();
      expect(ids(f.recall("feline"))).toEqual([cat]);
    }, emb);
  });

  it("OneRefusedMemoryDoesNotBlockTheRest", () => {
    const emb = new TopicEmbedder();
    return startEmbedded(async (f) => {
      emb.refuse = "毒丸";
      const poison = f.remember("毒丸", "嵌入服务不接受这一条。");
      const cat = f.remember("用户给我看了他的猫", "一只橘猫。");
      await f.sync();

      expect(f.indexed()).toBe(1);
      expect(ids(f.recall("feline"))).toEqual([cat]);
      expect(ids(f.recall("毒丸")), "the refused memory must stay findable by keyword").toEqual([poison]);
    }, emb);
  });

  // A restart is the object's instance being dropped: the vectors are loaded
  // again from storage by the first search, and the backlog by the alarm.
  it("VectorsSurviveRestartAndBacklogIsPickedUp", async () => {
    const stub = freshObject();
    const emb = new TopicEmbedder();
    const { cat, deploy, clock } = await startEmbedded(async (f) => {
      const cat = f.remember("用户给我看了他的猫", "一只橘猫。");
      await f.sync();
      emb.down = true;
      const deploy = f.remember("第一次部署出了问题", "反向代理拒绝了所有请求。"); // never embedded in this run
      return { cat, deploy, clock: f.clock };
    }, emb, stub);
    await evictDurableObject(stub);

    emb.down = false;
    const before = emb.documentCalls;
    await reopen(stub, emb, clock, async (f) => {
      expect(f.indexed(), "the stored vector was not loaded").toBeGreaterThanOrEqual(1);
      await f.sync();
      expect(f.indexed()).toBe(2);
      expect(ids(f.recall("kitten"))).toEqual([cat]);
      expect(ids(f.recall("release"))).toEqual([deploy]);
    });
    expect(emb.documentCalls, "the backlog was not embedded after restart").toBeGreaterThan(before);
  });

  it("WritesNeedASession", () =>
    start((f) => {
      const cases: [string, string, string][] = [
        ["no session id", "", "session_id is required: call get_context first and pass the session id it returns"],
        ["blank", "  ", "session_id is required: call get_context first and pass the session id it returns"],
        ["an id that names nothing", "s_nope", `unknown session_id "s_nope": call get_context and pass the session id it returns`],
      ];
      for (const [name, sessionId, want] of cases) {
        // The message is what the model sees: it has to say what to do.
        expect(f.obj.remember({ sessionId, gist: "g", body: "b" }), name).toEqual({ invalid: want });
      }
      expect(f.st.counts()).toEqual({ memories: 0, events: 0 });

      // The session id is all that ties a write to its conversation: the same
      // id from anywhere lands in the same session, with that session's carrier.
      const a = f.begin("model-a", "phone").session.id;
      const b = f.begin("model-b", "desktop").session.id;
      const one = f.rememberWith({ sessionId: a, gist: "在手机上发生的事", body: "正文" });
      const two = f.rememberWith({ sessionId: b, gist: "在桌面端发生的事", body: "正文" });
      const m1 = f.get(one), m2 = f.get(two);
      expect([m1.sessionId, m1.model, m1.client]).toEqual([a, "model-a", "phone"]);
      expect([m2.sessionId, m2.model, m2.client]).toEqual([b, "model-b", "desktop"]);
    }));

  it("ReadsDoNotNeedASession", () =>
    start((f) => {
      const id = f.remember("用户纠正了我", "我理解偏了。");
      for (const sessionId of ["", "s_nope"]) {
        const rs = f.obj.recall({ query: "纠正", sessionId });
        expect(!isInvalid(rs) && rs.length, `recall with session ${JSON.stringify(sessionId)}`).toBe(1);
        const es = f.obj.expand({ ids: [id], sessionId });
        expect(!isInvalid(es) && es.length, `expand with session ${JSON.stringify(sessionId)}`).toBe(1);
      }
      expect(f.get(id).recallCount).toBe(4);
      // An id that names nothing is not recorded as the session.
      const sessions = f.st.counts().events;
      expect(sessions).toBe(2 + 4);
      for (const { payload } of f.storage.sql.exec<{ payload: string }>(
        `SELECT payload FROM events WHERE kind IN ('recall', 'expand')`,
      )) {
        expect(JSON.parse(payload).session).toBeUndefined();
      }
    }));

  it("BeingListedIsRecordedButDoesNotStrengthen", () =>
    start((f) => {
      const id = f.remember("用户纠正了我", "我理解偏了。");
      f.fill(5);
      f.recall("纠正");
      f.recall("纠正");
      const m = f.get(id);
      expect([m.recallCount, m.strength, m.touchedOrd, m.readOrd]).toEqual([2, 10, 6, 1]);
    }));

  it("NewSessionIsToldOfOtherRecentOnes", () =>
    start((f) => {
      const others = (v: { others: { id: string }[] }) => v.others.map((o) => o.id);

      const a = f.begin("model-a", "phone"); // minute 0
      expect(others(a)).toEqual([]);
      f.advance(5 * minute);
      const b = f.begin("model-a", "desktop"); // minute 5
      expect(others(b)).toEqual([a.session.id]);
      expect(b.others[0]!.client).toBe("phone");
      expect(b.others[0]!.lastActiveAt).toBe(a.now);

      // Writing keeps a session active. One that has been silent for longer
      // than the window is not mentioned.
      f.advance(25 * minute);
      f.rememberWith({ sessionId: a.session.id, gist: "手机上继续聊", body: "正文" }); // minute 30
      f.advance(9 * minute);
      const c = f.begin("model-a", "cli"); // minute 40
      expect(others(c)).toEqual([a.session.id]);

      // Reading keeps a session active too.
      f.advance(20 * minute); // minute 60
      expect(isInvalid(f.obj.recall({ query: "手机", sessionId: b.session.id }))).toBe(false);
      f.advance(minute);
      const d = f.begin("model-a", "web"); // minute 61
      expect(others(d)).toEqual([b.session.id]);

      f.advance(3 * hour);
      expect(others(f.begin("model-a", "web"))).toEqual([]);

      // At most three are listed, the most recently active first.
      const recent: string[] = [];
      for (let i = 0; i < 4; i++) {
        f.advance(minute);
        recent.push(f.begin("model-a", "web").session.id);
      }
      f.advance(minute);
      expect(others(f.begin("model-a", "web"))).toEqual([recent[3], recent[2], recent[1]]);

      // Not in Go: the window is fifteen minutes to the millisecond.
      f.advance(hour);
      const x = f.begin("model-a", "web");
      f.advance(15 * minute);
      const y = f.begin("model-a", "web");
      expect(others(y)).toEqual([x.session.id]);
      f.advance(1);
      expect(others(f.begin("model-a", "web"))).toEqual([y.session.id]);
    }));

  it("ContextShowsRecentMemoriesAndNewCarriers", () =>
    start((f) => {
      let view = f.begin("model-a", "desktop");
      expect(view.counts).toEqual({ core: 0, active: 0, faded: 0, archived: 0 });
      expect(view.recent).toEqual([]);
      expect(view.carrier.first).toBe(false);
      expect(view.session.id).not.toBe("");
      expect(view.now).toBe(t0);
      f.session = view.session.id;
      let last = "";
      for (let i = 0; i < 10; i++) last = f.remember("第 " + String.fromCodePoint(0x4e00 + i) + " 件事", "正文");

      view = f.begin("model-b", "cli");
      expect([view.counts.active, view.clock, view.recent.length, view.recent[0]?.id]).toEqual([10, 10, 8, last]);
      expect(view.carrier).toEqual({ first: true, earlier: ["model-a"] });
      expect(view.session.id, "two calls to get_context returned the same session").not.toBe(f.session);
    }));

  it("takes two spellings of a model's name for one carrier", () =>
    start((f) => {
      f.session = f.begin("claude-sonnet-5-5", "web").session.id;
      f.remember("a first thing", "body");
      // Seen on a real client: the same model named itself both ways.
      let view = f.begin("Claude Sonnet 5.5", "phone");
      expect(view.carrier.first).toBe(false);
      expect(view.session.model, "a session keeps the name as it was given").toBe("Claude Sonnet 5.5");
      view = f.begin(" claude-fable-5-2 ", "web");
      expect(view.carrier).toEqual({ first: true, earlier: ["claude-sonnet-5-5"] });
      // A name with nothing to compare is no carrier.
      view = f.begin("...", "web");
      expect(view.carrier.first).toBe(false);
      view = f.begin("CLAUDE_FABLE 5.2", "web");
      expect(view.carrier.first).toBe(false);
    }));

  it("RememberValidation", () =>
    start((f) => {
      const long = (n: number) => "字".repeat(n);
      const sess = f.sess();
      // Go checks only that each is refused and is not about the session. The
      // messages are part of the interface, so they are pinned here.
      const cases: [string, RememberArgs, string][] = [
        ["no gist", { body: "b" }, "gist is required: one sentence saying what happened"],
        ["no body", { gist: "g" }, "body is required: what happened, in your own words"],
        ["blank gist", { gist: "  \n", body: "b" }, "gist is required: one sentence saying what happened"],
        ["gist too long", { gist: long(MaxGistRunes + 1), body: "b" }, "gist is 201 characters, the limit is 200: keep it to one sentence"],
        ["body too long", { gist: "g", body: long(MaxBodyRunes + 1) },
          "body is 6001 characters, the limit is 6000: a memory is an account of what you lived through, not a transcript or project notes"],
        ["lesson too long", { gist: "g", body: "b", lesson: long(MaxFieldRunes + 1) }, "lesson is 1001 characters, the limit is 1000"],
        ["bad moment", { gist: "g", body: "b", moment: "tuesday" },
          "moment must be one of start, blocked, corrected, breakthrough, finished, emotion, other"],
        ["bad source", { gist: "g", body: "b", source: "dreamed" }, "source must be one of lived, told, inferred, reconstructed"],
        ["importance > 1", { gist: "g", body: "b", importance: 1.5 }, "importance must be between 0 and 1"],
        ["importance < 0", { gist: "g", body: "b", importance: -0.1 }, "importance must be between 0 and 1"],
        ["intensity > 1", { gist: "g", body: "b", feeling: "f", intensity: 1.2 }, "feeling_intensity must be between 0 and 1"],
        ["intensity alone", { gist: "g", body: "b", intensity: 0.5 },
          "feeling_intensity needs a feeling: say what registered, or leave both out"],
        ["too many people", { gist: "g", body: "b", people: distinct(MaxPeople + 1) }, "at most 16 people per memory"],
      ];
      for (const [name, args, want] of cases) {
        expect(f.obj.remember({ ...args, sessionId: sess }), name).toEqual({ invalid: want });
      }
      expect(f.st.counts(), "rejected input left something behind").toEqual({ memories: 0, events: 1 });

      // Limits are counted in characters, not bytes, and defaults are filled in.
      const r = f.obj.remember({
        sessionId: "  " + sess + " ", gist: "  " + long(MaxGistRunes) + "  ", body: long(MaxBodyRunes), people: [" 年糕 ", "", "年糕"],
      });
      expect(isInvalid(r), "input at the limits was rejected").toBe(false);
      const m = f.get((r as { id: string }).id);
      expect([m.moment, m.source, m.importance, m.people, m.gist === long(MaxGistRunes)]).toEqual(["other", "lived", 0.5, ["年糕"], true]);

      // A blank query lists by time; a since that is not a date is refused.
      expect(f.obj.recall({ query: "  ", since: "soon" })).toEqual({ invalid: "cannot read since \"soon\" as a date: write it like 2026-03-14 or 2026-03-14T09:30:00Z" });
      expect(f.obj.expand({ ids: [] })).toEqual({ invalid: "ids is required" });
      expect(f.obj.expand({ ids: distinct(MaxExpand + 1) })).toEqual({ invalid: "at most 10 ids per call" });
    }));
});


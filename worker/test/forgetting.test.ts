// Port of internal/memory/forgetting_test.go. What Go checks after f.sync()
// is checked at once here: a listing or a reading is logged in the call that
// made it.

import { describe, expect, it } from "vitest";
import { tierTotal } from "../src/store/decay";
import { near } from "./helpers";
import { ids, start, startEmbedded, tiers } from "./service-helpers";

describe("forgetting", () => {
  it("TimeAloneForgetsNothing", async () => {
    await start((f) => {
      const id = f.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。");
      // Ten years with nothing lived through: nothing has moved.
      f.advance(10 * 365 * 24 * 60 * 60 * 1000);
      expect(f.tier(id)).toBe("active");
      expect(tiers(f.recall("年糕")), "ten years later its details are still searched").toEqual({ [id]: "active" });
    });
    // The same memory, one busy afternoon later.
    await start((f) => {
      const id = f.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。");
      f.fill(15);
      expect(f.tier(id)).toBe("faded");
    });
  });

  it("FadedMemoryIsFoundByGistAndBroughtBackByDeepRecall", () =>
    start((f) => {
      const id = f.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。");
      f.fill(15); // faded: past 13 newer memories, before 30
      expect(ids(f.recall("年糕")), "an ordinary recall searched the details of a faded memory").toEqual([]);
      let m = f.get(id);
      expect([m.recallCount, m.touchedOrd], "a recall that found nothing was counted").toEqual([0, 1]);

      expect(tiers(f.deepRecall("年糕"))).toEqual({ [id]: "faded" });
      // Listed, not read: within reach again, and no stronger than before.
      m = f.get(id);
      expect([f.tier(id), m.recallCount, m.strength]).toEqual(["active", 1, 10]);
      expect(tiers(f.recall("年糕")), "once back, its details are searched again").toEqual({ [id]: "active" });
    }));

  it("FadedGistStillComesToMind", () =>
    start((f) => {
      const id = f.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。");
      f.fill(15);
      expect(tiers(f.recall("猫")), "recall on a gist word").toEqual({ [id]: "faded" });
      // Coming to mind restarts its decay: it is active again afterwards.
      expect(f.tier(id)).toBe("active");
    }));

  it("ReadingInFullStrengthens", () =>
    start((f) => {
      const listed = f.remember("只被搜到的事", "正文甲");
      const read = f.remember("搜到后又读了全文的事", "正文乙");
      f.fill(20);

      // The usual sequence: a search lists it, then it is read in full.
      expect(f.recall("搜到")).toHaveLength(2);
      const r = f.expand(read);
      expect([r.body, r.tier]).toEqual(["正文乙", "active"]);

      const a = f.get(listed), b = f.get(read);
      // Twenty memories lay between writing it and reading it.
      expect(a.strength).toBe(10);
      near(b.strength, 10 * (1 + 2 * (1 - Math.exp(-2.0))), 1e-6);
      expect([a.recallCount, b.recallCount]).toEqual([1, 2]);

      // The stronger one outlasts the other.
      f.fill(20);
      expect([f.tier(listed), f.tier(read)]).toEqual(["faded", "active"]);
    }));

  it("ExpandReachesArchivedMemories", () =>
    start((f) => {
      const id = f.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。");
      f.fill(40);
      const r = f.expand(id);
      expect([r.tier, r.body]).toEqual(["archived", "一只橘猫，名字叫年糕。"]);
      const m = f.get(id);
      expect([f.tier(id), m.recallCount]).toEqual(["active", 1]);
      expect(m.strength, "nearly tripled").toBeGreaterThan(25);
    }));

  it("ArchivedMemoryNeedsDeepRecallAndIsEmbeddedAgain", () =>
    startEmbedded(async (f) => {
      const cat = f.remember("用户给我看了他的猫", "一只橘猫，名字叫年糕。");
      const core = f.rememberWith({ gist: "用户第一次把部署交给我", body: "上线很顺利。", importance: 0.95 });
      await f.sync();
      expect(f.indexed()).toBe(2);
      // After a sync, exactly the memories that are not archived have a vector.
      const indexedRight = (when: string) => {
        const c = f.counts();
        expect(f.indexed(), when).toBe(tierTotal(c) - c.archived);
      };

      f.fill(35); // past 30 newer memories: archived
      expect(f.tier(cat)).toBe("archived");
      // Before the sweep its vector is still stored; it must not come back
      // through it.
      expect(tiers(f.recall("feline")), "an archived memory came back through its vector").toEqual({});
      await f.sync(); // sweeps
      indexedRight("after the sweep");
      expect(tiers(f.recall("猫")), "an ordinary recall reached an archived memory").toEqual({});
      expect(tiers(f.recall("deploy")), "the core memory must still be found by meaning").toEqual({ [core]: "core" });

      expect(tiers(f.deepRecall("年糕"))).toEqual({ [cat]: "archived" });
      const before = f.indexed();
      await f.sync(); // it came to mind: it is embedded again
      expect(f.indexed()).toBe(before + 1);
      indexedRight("after it came back");
      expect(tiers(f.recall("feline"))).toEqual({ [cat]: "active" });
    }));

  it("RelevanceLeadsOverImportanceAndFreshness", () =>
    start((f) => {
      // Older and unimportant, but it is what the question is about.
      const target = f.rememberWith({ importance: 0.3, gist: "反向代理把请求全部拒绝了", body: "查了一个小时才发现是 Host 头的问题。" });
      f.fill(2);
      // Fresh and important, and it shares one common phrase with the question.
      const bystander = f.rememberWith({ importance: 0.85, gist: "用户说这个项目对他很重要", body: "他把请求列成了清单。" });
      f.remember("用户问了天气", "聊了几句。");
      expect(f.tier(target)).toBe("active");

      const rs = f.recall("反向代理为什么拒绝请求");
      expect(rs[0]?.id).toBe(target);
      // Being listed would restart its decay for a question it does not answer.
      expect(ids(rs)).not.toContain(bystander);
      expect(f.get(bystander).recallCount).toBe(0);
    }));

  it("RetentionBreaksTies", () =>
    start((f) => {
      const first = f.remember("第一次部署：一样的正文", "一样的正文");
      const second = f.remember("第二次部署：一样的正文", "一样的正文");
      // Eight memories on, only the first is brought back to mind.
      f.fill(8);
      expect(ids(f.recall("第一次"))).toEqual([first]);
      // Equal matches and equal importance: the better retained one comes
      // first, although the other is the newer of the two.
      expect(ids(f.recall("一样的正文"))).toEqual([first, second]);
    }));

  it("ContextShowsCoreFirstAndCountsTiers", () =>
    start((f) => {
      const core = f.rememberWith({ gist: "第一次被信任", body: "用户把整个项目交给了我。", importance: 0.95 });
      const old = f.remember("很久以前的小事", "正文");
      f.fill(14);
      const recent = f.remember("刚发生的事", "正文");

      // 17 memories: the core one, the 13 newest still active, 3 faded.
      let view = f.begin("model-a", "desktop");
      expect(view.counts).toEqual({ core: 1, active: 13, faded: 3, archived: 0 });
      expect(view.clock).toBe(17);
      expect(view.core.map((m) => m.id)).toEqual([core]);
      expect(view.recent).toHaveLength(8);
      expect(view.recent[0]!.id).toBe(recent);
      expect(view.recent.map((m) => m.id), "the core memory is listed twice").not.toContain(core);
      expect(f.tier(old)).toBe("faded");

      // Being shown at the start of a session is not coming to mind.
      for (const shown of [...view.recent, ...view.core]) {
        const m = f.get(shown.id);
        expect([m.recallCount, m.touchedOrd], `get_context touched ${m.id}`).toEqual([0, m.ord]);
      }
      expect(f.st.counts().events, "the 2 sessions and the 17 memories").toBe(2 + 17);

      // Sixty memories later the old one has left the list; the core one has not.
      f.fill(60);
      view = f.begin("model-a", "desktop");
      expect(view.counts).toEqual({ core: 1, active: 13, faded: 17, archived: 46 });
      expect([view.core.map((m) => m.id), view.recent.length]).toEqual([[core], 8]);
      expect(f.tier(old)).toBe("archived");
    }));

  // In Go, what comes to mind is written down a moment later by a background
  // worker, and memories written in that moment must not count as having
  // lain between. Here it is written in the same call, so the moment is
  // empty; the clock carried in the event must still be the one of the call.
  it("ComingToMindIsDatedWhenItHappens", () =>
    start((f) => {
      const read = f.remember("读过全文的事", "正文甲");
      const listed = f.remember("只被搜到的事", "正文乙");
      f.fill(5);
      f.expand(read); // 6 memories after it was written
      expect(ids(f.recall("搜到"))).toEqual([listed]);
      f.fill(10);

      const r = f.get(read);
      expect([r.readOrd, r.touchedOrd]).toEqual([7, 7]);
      near(r.strength, 10 * (1 + 2 * (1 - Math.exp(-0.6))), 1e-6);
      const l = f.get(listed);
      expect([l.touchedOrd, l.strength]).toEqual([7, 10]);
      for (const { payload } of f.storage.sql.exec<{ payload: string }>(
        `SELECT payload FROM events WHERE kind IN ('recall', 'expand')`,
      )) {
        expect(JSON.parse(payload).clock).toBe(7);
      }
    }));
});

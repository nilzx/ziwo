// Checks of the service and the object beyond the Go ports: recall's formula
// to the last bit, what expand and get_context return for every kind and
// standing of memory, and the object reached over RPC.

import { describe, expect, it } from "vitest";
import { type Content, encodeContent } from "../src/store/content";
import { retentionOf } from "../src/store/decay";
import { encodeRemember, type RememberEvent } from "../src/store/events";
import { defaultParams } from "../src/store/decay";
import { freshObject, hour, minute, t0 } from "./helpers";
import { type Fixture, ids, isInvalid, ok, start } from "./service-helpers";

let logged = 0;

// logRemember writes a remember event into the log, with its content unless
// it is null (an erased memory); the caller rebuilds.
function logRemember(f: Fixture, e: Partial<RememberEvent>, c: Content | null): string {
  const id = e.id ?? `m_mem${++logged}`;
  let hash = "";
  if (c !== null) {
    const enc = encodeContent(c);
    hash = enc.hash;
    f.storage.sql.exec(`INSERT INTO contents(id, data) VALUES(?, ?)`, id, enc.data);
  }
  const ev: RememberEvent = {
    id, session: f.sess(), kind: "", moment: "other", source: "lived", importance: 0.5, intensity: 0,
    hash, corrects: "", happened: 0, from: [], ref: "", milestone: false, ...e,
  };
  f.storage.sql.exec(`INSERT INTO events(at, kind, payload) VALUES(?, 'remember', ?)`, f.clock, encodeRemember(ev));
  return id;
}

function events(f: Fixture, kind: string): { at: number; payload: Record<string, unknown> }[] {
  return f.storage.sql
    .exec<{ at: number; payload: string }>(`SELECT at, payload FROM events WHERE kind = ? ORDER BY seq`, kind)
    .toArray()
    .map((r) => ({ at: r.at, payload: JSON.parse(r.payload) as Record<string, unknown> }));
}

describe("recall", () => {
  // Not Go's: found on the platform, where a memory sharing one passing word
  // with the query was listed ahead of the memory the query meant.
  it("scores a keyword match by how much of the search it holds", () =>
    start((f) => {
      const meant = f.remember("部署失败后回滚", "上线到一半报错。");
      const passing = f.remember("We went through the recipe", "Nothing about it went badly.");
      const whole = f.remember("The release went wrong", "So it was reverted.");
      f.fill(3);
      const [mm, mp, mw] = f.st.get([meant, passing, whole]);
      // With the memory that is meant found by meaning, it comes before the
      // ones that share one word of five with the query; without the factor
      // the best of those would score 0.5 against its 0.3 and come first.
      const byMeaning = f.obj.service.recall("they went looking for something else entirely", 5, false, "", [{ n: mm!.n, score: 0.6 }]);
      expect(ids(byMeaning)[0]).toBe(meant);
      expect(byMeaning[0]!.byKeyword).toBe(false);

      // By keyword alone: both are found, and the one holding all four terms
      // that are searched for (release, went, wrong, reverted) is listed; the
      // other holds one of the four.
      const query = "the release went wrong and we reverted it";
      const kw = f.st.searchText(query, f.lived(), false, 20);
      expect(kw.map((h) => h.n)).toEqual([mw!.n, mp!.n]);
      expect(ids(f.recall(query))).toEqual([whole]);
    }));

  it("keeps Go's formula: relevance, floor, score and order", () =>
    start((f) => {
      const x = f.remember("共同的词 甲", "正文");
      const y = f.rememberWith({ gist: "别的 乙", body: "正文", importance: 0.8 });
      const z = f.remember("别的 丙", "正文");
      const w = f.remember("共同的词 共同的词 丁", "正文");
      f.fill(3);
      const clock = f.lived();
      const [mx, my, mz, mw] = f.st.get([x, y, z, w]);
      const kw = f.st.searchText("共同的词", clock, false, 20);
      expect(kw.map((h) => h.n).sort()).toEqual([mx!.n, mw!.n].sort());
      const best = kw[0]!.score;
      const keyword = new Map(kw.map((h) => [h.n, h.score / best]));
      // x by both ways; y and z by meaning alone, y a little above the floor
      // and z a little below it; w by keyword alone.
      const top = Math.max(((keyword.get(mx!.n) ?? 0) + 0.8) / 2, (keyword.get(mw!.n) ?? 0) / 2);
      const meaning = [
        { n: mx!.n, score: 0.8 },
        { n: my!.n, score: 2 * 0.33 * top },
        { n: mz!.n, score: 2 * 0.27 * top },
      ];
      const relevance = (n: number) => ((keyword.get(n) ?? 0) + (meaning.find((h) => h.n === n)?.score ?? 0)) / 2;
      const score = (m: typeof mx) => relevance(m!.n) * (0.7 + 0.3 * m!.importance) * (0.5 + 0.5 * retentionOf(m!, clock));
      expect(Math.max(...[mx, my, mz, mw].map((m) => relevance(m!.n)))).toBe(top);

      const rs = f.recall("共同的词", meaning);
      const want = [mx, my, mw].sort((a, b) => score(b) - score(a) || b!.n - a!.n);
      expect(ids(rs)).toEqual(want.map((m) => m!.id));
      for (const r of rs) {
        const m = [mx, my, mw].find((m) => m!.id === r.id);
        expect(r.score, r.id).toBe(score(m));
        expect([r.byKeyword, r.byMeaning], r.id).toEqual([keyword.has(r.n), meaning.some((h) => h.n === r.n)]);
      }
      // The listing is logged with the query, the ids in order and the clock.
      expect(events(f, "recall").at(-1)!.payload).toEqual({ session: f.sess(), query: "共同的词", ids: ids(rs), clock });
    }));

  it("merges keyword matches down to four times the limit with the matches by meaning", () =>
    start((f) => {
      // p matches the query best by keyword; q matches less well by keyword
      // but is also found by meaning. Asked for one, recall must still weigh
      // q's keyword match: it searches deeper than the limit.
      const p = f.remember("深处 深处 深处", "正文");
      const q = f.remember("深处", "正文");
      const mq = f.get(q);
      const rs = f.obj.service.recall("深处", 1, false, "", [{ n: mq.n, score: 0.9 }]);
      expect(ids(rs)).toEqual([q]);
      expect(rs[0]!.byKeyword).toBe(true);
      expect(p).not.toBe(q);
    }));

  it("breaks a tie by the newer memory and keeps to the limit", () =>
    start((f) => {
      // Core, so retention is 1; identical, so the keyword scores are equal.
      const a = f.rememberWith({ gist: "同样的事", body: "同样的正文", importance: 0.95 });
      f.advance(11 * minute); // past the window in which a repeat is taken for a retry
      const b = f.rememberWith({ gist: "同样的事", body: "同样的正文", importance: 0.95 });
      const rs = f.recall("同样的事");
      expect(rs[0]!.score).toBe(rs[1]!.score);
      expect(ids(rs)).toEqual([b, a]);

      for (let i = 0; i < 22; i++) f.remember(`许多 ${i}`, "正文");
      const count = (limit?: number) => ok(f.obj.recall({ query: "许多", limit })).length;
      expect([count(), count(0), count(-3), count(7), count(20), count(25)]).toEqual([5, 5, 5, 7, 20, 20]);
    }));

  it("reaches what no longer stands only by a deep recall, and never what is set aside", () =>
    start((f) => {
      const old = f.remember("要被纠正的事", "正文");
      const retracted = f.remember("被收回的纠正", "正文");
      logRemember(f, { corrects: old }, { gist: "已经纠正的事", body: "正文" });
      logRemember(f, { kind: "self" }, { gist: "关于纠正的自述" });
      logRemember(f, { kind: "reading", ref: old }, { gist: "对纠正的理解" });
      f.st.rebuild();
      f.storage.sql.exec(`UPDATE memories SET retracted = 1 WHERE id = ?`, retracted);
      expect(ids(f.recall("纠正")).map((id) => f.get(id).gist)).toEqual(["已经纠正的事"]);
      expect(new Set(ids(f.deepRecall("纠正")).map((id) => f.get(id).gist))).toEqual(new Set(["已经纠正的事", "要被纠正的事"]));
    }));

  it("logs nothing when it finds nothing, and returns what was there before", () =>
    start((f) => {
      const id = f.remember("一件旧事", "正文");
      f.fill(15);
      expect(f.recall("没有这个词")).toEqual([]);
      expect(events(f, "recall")).toEqual([]);
      const [r] = f.recall("旧事");
      // Faded when it was found, active once it has come to mind.
      expect([r!.tier, r!.touchedOrd, r!.recallCount]).toEqual(["faded", 1, 0]);
      expect([f.tier(id), f.get(id).touchedOrd, f.get(id).recallCount]).toEqual(["active", 16, 1]);
      // The query is trimmed and clipped to 500 characters before it is logged.
      f.recall("  旧事 " + "x".repeat(600));
      expect(events(f, "recall").at(-1)!.payload.query).toBe(("旧事 " + "x".repeat(600)).slice(0, 500));
    }));
});

describe("expand", () => {
  it("returns every memory asked for and reads only those it can", () =>
    start((f) => {
      // Ids that sort against the order they were written in.
      const f1 = logRemember(f, { id: "m_zzzzzzz1" }, { gist: "第一件", body: "正文" });
      const f2 = logRemember(f, { id: "m_aaaaaaa2" }, { gist: "第二件", body: "正文" });
      const episode = logRemember(f, { kind: "episode", from: [f2, f1] }, { gist: "合起来", body: "正文" });
      const r1 = logRemember(f, { kind: "reading", ref: episode }, { gist: "后来的理解一" });
      const r2 = logRemember(f, { kind: "reading", ref: episode }, { gist: "后来的理解二" });
      const r3 = logRemember(f, { kind: "reading", ref: episode }, { gist: "后来的理解三" });
      const erased = logRemember(f, {}, null);
      const retracted = logRemember(f, {}, { gist: "收回的", body: "正文" });
      f.st.rebuild();
      // What a retraction leaves in the tables.
      f.storage.sql.exec(`UPDATE memories SET retracted = 1 WHERE id IN (?, ?)`, retracted, r3);
      f.advance(hour);

      const before = f.get(episode);
      const rs = ok(f.obj.expand({ ids: [" " + erased, "m_unknown", episode, "", retracted, episode + " "], sessionId: "s_nope" }));
      expect(ids(rs)).toEqual([erased, episode, retracted]);
      const [e, ep, rt] = rs;
      expect([e!.state, e!.sources, e!.readings]).toEqual(["erased", [], []]);
      expect(ep!.sources).toEqual([f1, f2]); // in the order they were written
      expect(ep!.readings.map((m) => m.id)).toEqual([r1, r2]); // the retracted one left out
      expect([ep!.strength, ep!.recallCount, ep!.tier, ep!.score, ep!.byKeyword]).toEqual([before.strength, 0, "active", 0, false]);
      expect(rt!.sources).toEqual([]);
      expect(rt!.retracted).toBe(true);

      // Only the episode was read: nothing is left of the erased one, and
      // the retracted one is set aside.
      expect(events(f, "expand")).toEqual([{ at: f.clock, payload: { ids: [episode], clock: 4 } }]);
      expect([f.get(episode).recallCount, f.get(retracted).recallCount, f.get(erased).recallCount]).toEqual([1, 0, 0]);
      expect(f.obj.expand({ ids: ["m_unknown"] })).toEqual([]);
      expect(events(f, "expand")).toHaveLength(1);
    }));
});

describe("get_context", () => {
  it("shows selves, preferences, the backlog and a recent restore, and touches nothing", () =>
    start((f) => {
      const self1 = logRemember(f, { kind: "self" }, { gist: "自述一", context: "c" });
      logRemember(f, { kind: "self", ref: self1 }, { gist: "自述一改", context: "c" });
      const self2 = logRemember(f, { kind: "self" }, { gist: "自述二" });
      f.remember("片段", "正文");
      for (const days of [6, 10]) {
        f.storage.sql.exec(`INSERT INTO events(at, kind, payload) VALUES(?, 'restore', ?)`, t0 - days * 24 * hour,
          `{"exported_at":${t0 - (days + 1) * 24 * hour},"events":3}`);
      }
      f.st.rebuild();
      // Preferences come from amend events, not ported yet: their table is
      // filled by hand.
      f.storage.sql.exec(`INSERT INTO policies(id, created_at, session_id, text, retired_at) VALUES
        ('p_b', ?, 's', 't', NULL), ('p_a', ?, 's', 't', NULL), ('p_c', ?, 's', 't', ?)`, t0, t0, t0 - hour, t0);
      const eventsBefore = f.st.counts().events;

      const view = f.begin("m".repeat(130), "c".repeat(121));
      expect(view.selves.map((m) => m.gist)).toEqual(["自述一改", "自述二"]); // oldest first, replaced left out
      expect(view.selves[1]!.id).toBe(self2);
      expect(view.prefs.map((p) => p.id)).toEqual(["p_a", "p_b"]);
      expect(view.pending).toBe(1);
      expect(view.restored).toEqual({ at: t0 - 6 * 24 * hour, exportedAt: t0 - 7 * 24 * hour });
      expect([view.session.model.length, view.session.client.length]).toEqual([120, 120]);
      expect(f.st.counts().events, "only the session is logged").toBe(eventsBefore + 1);

      f.advance(24 * hour);
      expect(f.begin("model", "cli").restored).toBeNull();
    }));

  it("lists twelve core memories at most, and eight recent ones besides", () =>
    start((f) => {
      const core: string[] = [];
      for (let i = 0; i < 14; i++) core.push(f.rememberWith({ gist: `核心 ${i}`, body: "正文", importance: 0.9 + (i % 3) * 0.04 }));
      const recent: string[] = [];
      for (let i = 0; i < 10; i++) recent.push(f.remember(`最近 ${i}`, "正文"));
      // The newest of all is core: it is listed once, under core.
      const newest = f.rememberWith({ gist: "最新的核心", body: "正文", importance: 0.99 });
      core.unshift(newest);
      const view = f.begin("model", "cli");
      // Most important first, then the newest.
      const byRank = core
        .map((id) => ({ id, m: f.get(id) }))
        .sort((a, b) => b.m.importance - a.m.importance || b.m.n - a.m.n)
        .map((x) => x.id);
      expect(view.core.map((m) => m.id)).toEqual(byRank.slice(0, 12));
      expect(view.recent.map((m) => m.id)).toEqual(recent.slice(2).reverse());
      expect(view.core[0]!.id).toBe(newest);
      expect(view.counts).toEqual({ core: 15, active: 10, faded: 0, archived: 0 });
    }));
});

describe("store reads", () => {
  it("pending lists the fragments reflect has not dealt with, nearest to fading first", () =>
    start((f) => {
      const a = f.rememberWith({ gist: "普通", body: "正文" });
      const weak = f.rememberWith({ gist: "弱的", body: "正文", importance: 0.2 });
      const core = f.rememberWith({ gist: "核心", body: "正文", importance: 0.95 });
      const told = f.rememberWith({ gist: "听来的", body: "正文", source: "told" });
      const absorbed = f.remember("被合并的", "正文");
      const retracted = f.remember("收回的", "正文");
      logRemember(f, { kind: "episode", from: [absorbed] }, { gist: "经历", body: "正文" });
      f.st.rebuild();
      f.storage.sql.exec(`UPDATE memories SET retracted = 1 WHERE id = ?`, retracted);

      const want = [a, weak, core, told]
        .map((id) => f.get(id))
        .sort((x, y) => Number(x.core) - Number(y.core) || x.fadeAt - y.fadeAt || x.n - y.n)
        .map((m) => m.id);
      expect(want.at(-1)).toBe(core); // a core memory never fades: it comes last
      expect(want[0]).toBe(weak);
      expect(f.st.pending(10).map((m) => m.id)).toEqual(want);
      expect(f.st.pending(2).map((m) => m.id)).toEqual(want.slice(0, 2));
      expect(f.st.pendingCount()).toBe(4);
      expect(f.st.pending(10).every((m) => m.pending)).toBe(true);
    }));
});

describe("object", () => {
  it("adds up the rows of every cursor it consumes", () =>
    start((f) => {
      // Two rows of one vector each.
      f.storage.sql.exec(`INSERT INTO vector_rows(model, dims, count, ns, vecs) VALUES('m', 1, 1, x'01000000', x'7f'), ('m', 1, 1, x'02000000', x'7f')`);
      f.obj.usage(true);
      f.st.clock(); // one row of meta, read with first()
      expect(f.obj.usage(true)).toEqual({ rowsRead: 1, rowsWritten: 0 });
      const seen = f.st.vectorCount({ model: "m", dims: 1 }); // read one row at a time
      expect([seen, f.obj.usage(true).rowsRead]).toEqual([2, 2]);
      f.storage.sql.exec(`INSERT INTO policies(id, created_at, session_id, text) VALUES ('p_a', 1, 's', 't'), ('p_b', 2, 's', 't')`);
      f.st.preferences(); // all(); the platform counts the sort too
      const u = f.obj.usage(true);
      expect([u.rowsRead > 0, u.rowsWritten]).toEqual([true, 0]);
      f.st.setTokenHash("x"); // run()
      expect(f.obj.usage(true).rowsWritten).toBeGreaterThan(0);
    }));

  it("answers over RPC, with what the caller can fix as data", async () => {
    const stub = freshObject();
    const view = await stub.getContext({ model: "model-a", client: "cli" });
    if (isInvalid(view)) throw new Error(view.invalid);
    expect(view.session.id).toMatch(/^s_[a-z2-9]{8}$/);

    expect(await stub.remember({ sessionId: "s_nope", gist: "g", body: "b" })).toEqual({
      invalid: `unknown session_id "s_nope": call get_context and pass the session id it returns`,
    });
    const r = await stub.remember({ sessionId: view.session.id, gist: "一件事", body: "正文" });
    if (isInvalid(r)) throw new Error(r.invalid);
    expect(await stub.remember({ sessionId: view.session.id, gist: "一件事", body: "正文" })).toEqual({ id: r.id, dup: true });

    const rs = await stub.recall({ query: "一件事" });
    if (isInvalid(rs)) throw new Error(rs.invalid);
    expect(rs.map((x) => [x.id, x.tier, x.byKeyword, x.recallCount])).toEqual([[r.id, "active", true, 0]]);
    // A query is no longer required (a recall without one lists by time);
    // a since that is not a date is what the caller can fix here.
    expect(await stub.recall({ query: " ", since: "soon" })).toEqual({ invalid: "cannot read since \"soon\" as a date: write it like 2026-03-14 or 2026-03-14T09:30:00Z" });
    const es = await stub.expand({ ids: [r.id] });
    if (isInvalid(es)) throw new Error(es.invalid);
    expect(es[0]!.recallCount).toBe(1);

    expect(await stub.params()).toEqual(defaultParams());
    const bad = await stub.setParams({ ...defaultParams(), fadeBelow: 0.01 });
    expect(bad).toEqual({ invalid: "need 0 < archive threshold < fade threshold < 1, got archive 0.05, fade 0.01" });
    expect(await stub.setParams({ ...defaultParams(), baseStrength: 50 })).toEqual({ ...defaultParams(), baseStrength: 50 });
    expect((await stub.params()).baseStrength).toBe(50);

    const report = await stub.check();
    expect(report.findings.filter((x) => x.level !== "note")).toEqual([]);

    const u = await stub.usage(true);
    expect(u.rowsRead).toBeGreaterThan(0);
    expect(u.rowsWritten).toBeGreaterThan(0);
    expect(await stub.usage()).toEqual({ rowsRead: 0, rowsWritten: 0 });
    // Methods that change nothing still count what they read.
    await stub.recall({ query: "一件事" });
    const after = await stub.usage();
    expect(after.rowsRead).toBeGreaterThan(0);
  });
});

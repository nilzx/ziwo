// Port of internal/store/store_test.go.

import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dedupWindow, NoSessionError } from "../src/store/store";
import type { RememberInput } from "../src/store/types";
import {
  dump,
  freshObject,
  get,
  hour,
  inObject,
  minute,
  near,
  populate,
  remember,
  search,
  session,
  t0,
  testParams,
  unit,
  withStore,
} from "./helpers";

describe("store", () => {
  it("KeywordSearch", () =>
    withStore((s) => {
      const sess = session(s, t0, "model-a", "desktop");
      const corrected = remember(s, t0, sess, "用户纠正了我对记忆系统的理解", "我把它当成了项目笔记本，用户说它应该记的是经历和感受。");
      const deploy = remember(s, t0 + minute, sess,
        "First deployment went wrong", "The reverse proxy rejected every request until the Host header was fixed.");
      const cat = remember(s, t0 + 2 * minute, sess, "用户给我看了他的猫", "一只橘猫，名字叫年糕。");

      const cases: [string, string[]][] = [
        ["纠正", [corrected]],
        ["项目笔记本", [corrected]],
        ["猫", [cat]],
        ["年糕", [cat]],
        ["PROXY", [deploy]],
        ["host header", [deploy]],
        ["完全无关的词", []],
        ["...", []],
      ];
      for (const [query, want] of cases) expect(search(s, query), query).toEqual(want);

      // A natural-language question shares only some two-character pieces
      // with the memory, and still has to find it first.
      expect(search(s, "上次用户是怎么纠正我的理解的")[0]).toBe(corrected);
    }));

  it("EventsAreAppendOnly", () =>
    withStore((s, storage) => {
      session(s, t0, "model-a", "desktop");
      for (const stmt of [`UPDATE events SET payload = '{}'`, `DELETE FROM events`]) {
        expect(() => storage.sql.exec(stmt), stmt).toThrow(/append-only/);
      }
      expect(s.counts().events).toBe(1);
    }));

  it("RememberDeduplicatesRetries", () =>
    withStore((s) => {
      const sess = session(s, t0, "", "cli");
      const input: RememberInput = {
        sessionId: sess, moment: "other", source: "lived", importance: 0.5, gist: "同一件事", body: "写了两次",
      };
      const first = s.remember(t0, input);
      expect(first.dup).toBe(false);
      expect(s.remember(t0 + minute, input)).toEqual({ id: first.id, dup: true });
      // A retry is not a new experience.
      expect(s.clock()).toBe(1);
      const later = s.remember(t0 + dedupWindow + minute, input);
      expect(later.dup).toBe(false);
      expect(later.id).not.toBe(first.id);
      expect(s.counts().memories).toBe(2);
    }));

  it("RememberNeedsASession", () =>
    withStore((s) => {
      const input = (sessionId: string): RememberInput => ({
        sessionId, moment: "other", source: "lived", importance: 0.5, gist: "g", body: "b",
      });
      expect(() => s.remember(t0, input("s_missing"))).toThrow(NoSessionError);
      expect(s.counts().events).toBe(0);

      // Repeating what a real session just wrote does not get it past the check.
      const sess = session(s, t0, "", "cli");
      remember(s, t0, sess, "g", "b");
      for (const id of ["s_missing", ""]) {
        let caught: unknown;
        try {
          s.remember(t0 + 1000, input(id));
        } catch (err) {
          caught = err;
        }
        expect(caught, `session ${JSON.stringify(id)}`).toBeInstanceOf(NoSessionError);
        expect((caught as NoSessionError).sessionId).toBe(id);
      }
    }));

  it("CarrierNote", () =>
    withStore((s) => {
      const start = (at: number, model: string) => s.startSession(at, model, "desktop").note;
      expect(start(t0, "model-a")).toEqual({ first: false, earlier: [] });
      expect(start(t0 + hour, "model-a").first).toBe(false);
      expect(start(t0 + 2 * hour, "")).toEqual({ first: false, earlier: [] });
      expect(start(t0 + 3 * hour, "model-b")).toEqual({ first: true, earlier: ["model-a"] });
      expect(start(t0 + 4 * hour, "model-a")).toEqual({ first: false, earlier: ["model-b"] });
    }));

  it("MemoryCarriesItsCarrier", () =>
    withStore((s) => {
      const a = session(s, t0, "model-a", "desktop");
      const b = session(s, t0 + hour, "model-b", "cli");
      const first = remember(s, t0, a, "第一段", "由 model-a 写下");
      const second = remember(s, t0 + hour, b, "第二段", "由 model-b 写下");
      const ms = s.get([second, "m_unknown", first]);
      expect(ms.map((m) => m.id)).toEqual([second, first]);
      expect(ms.map((m) => `${m.model}/${m.client}`)).toEqual(["model-b/cli", "model-a/desktop"]);
    }));

  it("ActiveSessions", () =>
    withStore((s) => {
      const a = session(s, t0, "model-a", "desktop");
      const b = session(s, t0 + 10 * minute, "model-b", "cli");
      const c = session(s, t0 + 20 * minute, "", "web");
      const ids = (since: number, except: string) => s.activeSessions(since, except, 10).map((x) => x.id);

      expect(ids(t0 + 5 * minute, c)).toEqual([b]);

      // Writing and recalling count as activity; the newest activity comes first.
      const m = remember(s, t0 + 30 * minute, a, "一件事", "正文");
      s.logRecalls([{ at: t0 + 40 * minute, session: b, query: "q", ids: [m] }]);
      expect(ids(t0 + 25 * minute, c)).toEqual([b, a]);
      const sa = s.session(a);
      expect(sa?.startedAt).toBe(t0);
      expect(sa?.lastActiveAt).toBe(t0 + 30 * minute);
    }));

  // Adapted from TestLogOnlyLeavesDerivedTablesAlone: there is no log-only
  // open here, but the token hash, the log statistics and a reopen that must
  // not change the derived tables are the same.
  it("TokenHashLogStatsAndReopen", async () => {
    const stub = freshObject();
    const before = await inObject(stub, (s, storage) => {
      expect(s.tokenHash()).toBeUndefined();
      expect(s.logStats()).toEqual({ memories: 0, events: 0, lastEventAt: null, hasToken: false });
      s.setTokenHash("abc123");
      s.setParams(testParams());
      const sess = session(s, t0, "", "cli");
      remember(s, t0 + minute, sess, "一件事", "正文");
      expect(s.tokenHash()).toBe("abc123");
      expect(s.logStats()).toEqual({ memories: 1, events: 2, lastEventAt: t0 + minute, hasToken: true });
      return dump(s, storage);
    });
    await evictDurableObject(stub);
    const after = await inObject(stub, (s, storage) => dump(s, storage));
    expect(after).toBe(before);
  });

  it("RebuildReproducesDerivedTables", () =>
    withStore((s, storage) => {
      populate(s);
      const before = dump(s, storage);
      s.rebuild();
      expect(dump(s, storage)).toBe(before);
    }));

  it("ReopenKeepsEverythingAndUpgradesDerivedTables", async () => {
    const stub = freshObject();
    const before = await inObject(stub, (s, storage) => {
      s.setParams(testParams());
      populate(s);
      const d = dump(s, storage);
      // Stand in for an older release: stale version marker, derived tables
      // in a layout this code does not know.
      storage.sql.exec(`UPDATE meta SET value = '0' WHERE key = 'derived'`);
      storage.sql.exec(`DROP TABLE memories`);
      storage.sql.exec(`CREATE TABLE memories(old_layout TEXT)`);
      return d;
    });
    await evictDurableObject(stub);
    const after = await inObject(stub, (s, storage) => dump(s, storage));
    expect(after).toBe(before);
  });

  // Vectors are stored as 8-bit integers, packed: see vectors.test.ts for
  // the packing itself.
  it("VectorsRoundTripPerModel", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "", "cli");
      const m1 = get(s, remember(s, t0, sess, "一", "一"));
      const m2 = get(s, remember(s, t0, sess, "二", "二"));
      const x = { model: "model-x", dims: 4 };
      const want = unit([0.5, -0.25, 1e-7, 0.8]);
      s.saveVectors(x, [{ n: m1.n, vec: unit([1, 2, 3, 4]) }]);
      s.saveVectors(x, [{ n: m1.n, vec: want }]); // replaces
      s.saveVectors({ model: "model-y", dims: 1 }, [{ n: m1.n, vec: [1] }]);

      const rows = storage.sql.exec<{ count: number; vecs: ArrayBuffer }>(`SELECT count, vecs FROM vector_rows WHERE model = 'model-x'`).toArray();
      expect(rows.map((r) => [r.count, [...new Int8Array(r.vecs)]])).toEqual([[1, want.map((v) => Math.round(v * 127))]]);
      const hits = s.searchVectors(x, Float32Array.from(want), 10, 0.45);
      expect(hits.map((h) => h.n)).toEqual([m1.n]);
      near(hits[0]!.score, 1, 0.01);

      expect(s.tendVectors(x).waiting).toEqual([m2.n]);
      expect(s.tendVectors({ model: "model-z", dims: 4 }).waiting).toEqual([m1.n, m2.n]);
    }));
});

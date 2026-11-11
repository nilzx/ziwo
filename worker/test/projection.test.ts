// Checks that are new on this platform: the whole of applyRemember, the clock
// kept in meta, and replay reproducing the derived tables row for row. The
// Go build tests the later kinds of memory through amend and reflect, which
// are not ported yet, so this test writes their events into the log directly,
// as an import would, and lets a rebuild project them.

import { describe, expect, it } from "vitest";
import { type Content, encodeContent } from "../src/store/content";
import { encodeRemember, encodeSession, type RememberEvent } from "../src/store/events";
import type { Store } from "../src/store/store";
import { dump, fill, get, hour, near, populate, read, remember, session, t0, unit, withStore } from "./helpers";

type Write = { e: Partial<RememberEvent> & { id: string }; c: Content | null; at?: number };

// writeLog appends a session and the given remember events, with their
// content unless it is null (an erased memory), then rebuilds.
function writeLog(s: Store, storage: DurableObjectStorage, writes: Write[]): void {
  storage.sql.exec(`INSERT INTO events(at, kind, payload) VALUES(?, 'session', ?)`, t0,
    encodeSession({ id: "s_aaaaaaaa", model: "model-a", client: "cli" }));
  for (const { e, c, at } of writes) {
    let hash = "";
    if (c !== null) {
      const enc = encodeContent(c);
      hash = enc.hash;
      storage.sql.exec(`INSERT INTO contents(id, data) VALUES(?, ?)`, e.id, enc.data);
    }
    const ev: RememberEvent = {
      session: "s_aaaaaaaa", kind: "", moment: "other", source: "lived", importance: 0.5, intensity: 0,
      hash, corrects: "", happened: 0, from: [], ref: "", milestone: false, ...e,
    };
    storage.sql.exec(`INSERT INTO events(at, kind, payload) VALUES(?, 'remember', ?)`, at ?? t0 + hour, encodeRemember(ev));
  }
  storage.sql.exec(`INSERT INTO events(at, kind, payload) VALUES(?, 'restore', ?)`, t0 + 2 * hour,
    `{"from":"i_aaaaaaaa","exported_at":${t0},"events":12}`);
  s.rebuild();
}

describe("projection", () => {
  it("applies every kind of remember event", () =>
    withStore((s, storage) => {
      writeLog(s, storage, [
        { e: { id: "m_f1" }, c: { gist: "fragment one", body: "alpha" } },
        { e: { id: "m_f2" }, c: { gist: "fragment two", body: "beta" } },
        { e: { id: "m_c1", corrects: "m_f1" }, c: { gist: "correction", body: "gamma" } },
        { e: { id: "m_s1", kind: "self" }, c: { gist: "self one", context: "work" } },
        { e: { id: "m_s2", kind: "self", ref: "m_s1" }, c: { gist: "self two", context: "work" } },
        { e: { id: "m_i1", kind: "impression" }, c: { gist: "impression one", about: "kappa" } },
        { e: { id: "m_i2", kind: "impression" }, c: { gist: "impression two", about: "kappa" } },
        { e: { id: "m_i3", kind: "impression" }, c: { gist: "impression three", about: "lambda" } },
        { e: { id: "m_e1", kind: "episode", from: ["m_f2", "m_s2"] }, c: { gist: "episode", body: "delta" } },
        { e: { id: "m_l1", kind: "lesson" }, c: { gist: "lesson", lesson: "epsilon" } },
        { e: { id: "m_r1", source: "reconstructed", happened: t0 - 24 * hour }, c: { gist: "reconstructed", body: "zeta" } },
        { e: { id: "m_x1" }, c: null }, // erased: still lived through, says nothing
        { e: { id: "m_m1", kind: "episode", milestone: true }, c: { gist: "milestone", body: "eta" } },
      ]);

      // Only f1, f2 and the erased fragment were written as they happened.
      expect(s.clock()).toBe(3);
      expect(storage.sql.exec(`SELECT MAX(ord) AS c FROM memories`).one().c).toBe(3);

      const m = (id: string) => get(s, id);
      expect([m("m_f1").state, m("m_f1").stateBy]).toEqual(["superseded", "m_c1"]);
      expect([m("m_c1").state, m("m_c1").ord, m("m_c1").corrects]).toEqual(["", 2, "m_f1"]);
      expect([m("m_s1").state, m("m_s1").stateBy, m("m_s2").state]).toEqual(["superseded", "m_s2", ""]);
      expect([m("m_s1").core, m("m_s2").core, m("m_s2").ref]).toEqual([true, true, "m_s1"]);
      expect([m("m_i1").state, m("m_i2").state, m("m_i3").state]).toEqual(["superseded", "", ""]);
      // An episode absorbs the fragments it was made from, and only fragments.
      expect([m("m_f2").state, m("m_f2").stateBy, m("m_f2").pending]).toEqual(["absorbed", "m_e1", false]);
      expect(m("m_s2").state).toBe("");
      expect(storage.sql.exec(`SELECT src, dst FROM links ORDER BY dst`).toArray()).toEqual([
        { src: "m_e1", dst: "m_f2" },
        { src: "m_e1", dst: "m_s2" },
      ]);
      expect(storage.sql.exec(`SELECT reviewed FROM memories WHERE id IN ('m_f2', 'm_e1', 'm_f1') ORDER BY n`).toArray())
        .toEqual([{ reviewed: null }, { reviewed: 2 }, { reviewed: 2 }]);
      expect([m("m_c1").pending, m("m_r1").pending]).toEqual([true, true]);

      // Strength by kind: episode 2, impression 3, lesson 4, with base 10.
      near(m("m_e1").strength, 20, 1e-9);
      near(m("m_i2").strength, 30, 1e-9);
      near(m("m_l1").strength, 40, 1e-9);
      expect([m("m_m1").core, m("m_m1").milestone, m("m_m1").fadeAt]).toEqual([true, true, 0]);

      // A reconstructed memory took place when it says, and did not tick.
      expect([m("m_r1").createdAt, m("m_r1").writtenAt, m("m_r1").ord]).toEqual([t0 - 24 * hour, t0 + hour, 2]);

      const x = m("m_x1");
      expect([x.state, x.gist, x.ord, x.people]).toEqual(["erased", "", 3, []]);
      expect(storage.sql.exec(`SELECT hash FROM memories WHERE id = 'm_x1'`).one().hash).toBe("");

      expect(s.searchText("alpha", s.clock(), true, 10)).toHaveLength(1); // superseded: deep only
      expect(s.searchText("alpha", s.clock(), false, 10)).toHaveLength(0);
      expect(s.searchText("beta", s.clock(), true, 10)).toHaveLength(1); // absorbed: deep only
      expect(s.searchText("kappa", s.clock(), false, 10)).toHaveLength(1); // the impression that stands
      expect(s.searchText("work", s.clock(), true, 10)).toHaveLength(0); // statements about oneself are not listed
      expect(s.tierCounts(s.clock())).toEqual({ core: 1, active: 6, faded: 0, archived: 0 });

      expect(storage.sql.exec(`SELECT * FROM restores`).toArray()).toEqual([{ at: t0 + 2 * hour, exported_at: t0, events: 12 }]);
      // Every remember event was counted.
      expect(s.counts()).toEqual({ memories: 13, events: 15 });

      const before = dump(s, storage);
      s.rebuild();
      expect(dump(s, storage)).toBe(before);
    }));

  // Writes, listings and readings made through the store leave the same
  // derived tables, clock and all, as a replay of the log they wrote.
  it("replay reproduces live writes row for row", () =>
    withStore((s, storage) => {
      populate(s);
      const sess = session(s, t0 + 5 * hour, "model-c", "web");
      const ids = Array.from({ length: 30 }, (_, i) => remember(s, t0 + 5 * hour + i, sess, `item ${i}`, "body"));
      fill(s, sess, 20);
      s.logRecalls([
        { at: t0 + 6 * hour, session: sess, query: "item", ids: ids.slice(0, 10), clock: 40 },
        { at: t0 + 6 * hour, session: sess, read: true, ids: ids.slice(0, 3), clock: 45 },
        { at: t0 + 6 * hour, read: true, ids: [ids[5]!, "m_unknown"] },
      ]);
      fill(s, sess, 15);
      read(s, ...ids.slice(10, 15));
      s.saveVectors({ model: "embed-x", dims: 3 }, [{ n: get(s, ids[0]!).n, vec: unit([1, 2, 3]) }]);
      const clock = s.clock();
      expect(clock).toBe(3 + 4 + 30 + 20 + 15); // populate wrote three memories and four fillers
      expect(storage.sql.exec(`SELECT MAX(ord) AS c FROM memories`).one().c).toBe(clock);

      const before = dump(s, storage);
      s.rebuild();
      expect(dump(s, storage)).toBe(before);
      expect(s.clock()).toBe(clock);
    }));

  it("get takes more ids than the platform's limit on bound parameters", () =>
    withStore((s) => {
      const sess = session(s, t0, "", "cli");
      const ids = Array.from({ length: 120 }, (_, i) => remember(s, t0, sess, `n ${i}`, "b"));
      const asked = [...ids].reverse().flatMap((id, i) => (i % 2 === 0 ? [id, "m_missing"] : [id]));
      expect(s.get(asked).map((m) => m.id)).toEqual([...ids].reverse());
      const ns = s.get(ids).map((m) => m.n);
      expect(s.byN(ns).size).toBe(120);
    }));
});

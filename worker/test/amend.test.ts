// Port of internal/store/amend_test.go.

import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AmendPin, AmendReweigh, AmendRestore, AmendRetract, AmendUnpin } from "../src/store/amend";
import { KindFragment, SourceReconstructed, StateErased, StateSuperseded } from "../src/store/content";
import { sha256Hex } from "../src/store/ids";
import { decodeRemember, encodeAmend, encodeErase, encodeReflect, encodeRemember } from "../src/store/events";
import { tierOf, tierTotal } from "../src/store/decay";
import {
  ErasedError,
  NoMemoryError,
  NoPreferenceError,
  NoSessionError,
  SupersededError,
  TooManyPreferencesError,
} from "../src/store/errors";
import { isLive } from "../src/store/types";
import { amend, recentIDs, replays, tablesHolding, thrown } from "./amend-helpers";
import {
  fill,
  freshObject,
  get,
  hour,
  inObject,
  minute,
  near,
  remember,
  rememberWith,
  search,
  session,
  t0,
  testParams,
  withStore,
} from "./helpers";

const day = 24 * hour;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Not in amend_test.go: the payloads are what Go's encoding/json writes for
// amendEvent, eraseEvent, reflectEvent and the lease (Go 1.27).
describe("stored forms of amend, erase and reflect", () => {
  it("events", () => {
    expect(encodeAmend({ session: "s_a", action: "pin", id: "m_a", importance: 0, text: "", reason: "" }))
      .toBe(`{"session":"s_a","action":"pin","id":"m_a","importance":0}`);
    expect(encodeAmend({ session: "s_a", action: "reweigh", id: "m_a", importance: 0.25, text: "", reason: "the user <asked> & said" }))
      .toBe(String.raw`{"session":"s_a","action":"reweigh","id":"m_a","importance":0.25,"reason":"the user \u003casked\u003e \u0026 said"}`);
    expect(encodeAmend({ session: "s_a", action: "prefer", id: "p_a", importance: 0, text: "不用记天气", reason: "" }))
      .toBe(`{"session":"s_a","action":"prefer","id":"p_a","importance":0,"text":"不用记天气"}`);
    expect(encodeErase({ session: "s_a", id: "m_a", reason: "" })).toBe(`{"session":"s_a","id":"m_a"}`);
    expect(encodeErase({ session: "s_a", id: "m_a", reason: "r" })).toBe(`{"session":"s_a","id":"m_a","reason":"r"}`);
    expect(encodeReflect({ session: "s_a", batch: "b_a", passed: [], wrote: [] })).toBe(`{"session":"s_a","batch":"b_a"}`);
    expect(encodeReflect({ session: "s_a", batch: "b_a", passed: ["m_1"], wrote: ["m_2", "m_3"] }))
      .toBe(`{"session":"s_a","batch":"b_a","passed":["m_1"],"wrote":["m_2","m_3"]}`);
    // New here: replaces comes last, and only when there is something in it.
    const e = {
      id: "m_x", session: "s_x", kind: "impression", moment: "", source: "lived", importance: 0.5, intensity: 0, hash: "h",
      corrects: "", happened: 0, from: ["m_f"], ref: "", milestone: false,
    };
    expect(encodeRemember({ ...e, replaces: ["m_1", "m_2"] })).toBe(
      `{"id":"m_x","session":"s_x","kind":"impression","moment":"","source":"lived","importance":0.5,"hash":"h","from":["m_f"],"replaces":["m_1","m_2"]}`,
    );
    expect(encodeRemember({ ...e, replaces: [] })).toBe(encodeRemember(e));
    expect(decodeRemember(encodeRemember(e)).replaces).toBeUndefined();
    expect(decodeRemember(`{"id":"m_x","replaces":null}`).replaces).toBeUndefined();
    expect(decodeRemember(`{"id":"m_x","replaces":[]}`).replaces).toEqual([]);
  });

  it("the lease and what the store writes", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "", "cli");
      const id = remember(s, t0, sess, "一件事", "正文");
      const batch = s.beginReflect(t0, sess, 15 * minute);
      expect(storage.sql.exec(`SELECT value FROM meta WHERE key = 'reflect'`).one().value)
        .toBe(`{"batch":"${batch}","session":"${sess}","until":${t0 + 15 * minute}}`);
      const [made] = s.finishReflect(t0, sess, batch, [
        { kind: "lesson", gist: "g", body: "b", outcome: "", feeling: "", intensity: 0, lesson: "", people: [], pointer: "",
          importance: 0.5, about: "", context: "", from: [id], ref: "", milestone: false },
      ], [id]);
      s.amend(t0, sess, AmendReweigh, id, 0.25, "");
      s.erase(t0, sess, made!, "why");
      const payloads = storage.sql
        .exec<{ kind: string; payload: string }>(`SELECT kind, payload FROM events WHERE kind IN ('reflect', 'amend', 'erase') ORDER BY seq`)
        .toArray()
        .map((r) => `${r.kind} ${r.payload}`);
      expect(payloads).toEqual([
        `reflect {"session":"${sess}","batch":"${batch}","passed":["${id}"],"wrote":["${made}"]}`,
        `amend {"session":"${sess}","action":"reweigh","id":"${id}","importance":0.25}`,
        `erase {"session":"${sess}","id":"${made}","reason":"why"}`,
      ]);
      const lesson = JSON.parse(storage.sql.exec<{ payload: string }>(`SELECT payload FROM events WHERE kind = 'remember' ORDER BY seq DESC LIMIT 1`).one().payload);
      // What reflect writes has no moment, as in Go.
      expect([lesson.moment, lesson.kind, lesson.source, lesson.from]).toEqual(["", "lesson", "lived", [id]]);
      expect(storage.sql.exec(`SELECT count(*) AS c FROM meta WHERE key = 'reflect'`).one().c).toBe(0);
    }));
});

describe("amend", () => {
  it("WhatAMemorySaysIsNotInItsEvent", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "", "cli");
      const id = remember(s, t0, sess, "用户给我看了他的猫", "一只橘猫，名字叫年糕。");
      const payload = storage.sql.exec<{ payload: string }>(`SELECT payload FROM events WHERE kind = 'remember'`).one().payload;
      expect(payload.includes("猫") || payload.includes("年糕"), "the event holds what the memory says").toBe(false);
      const data = storage.sql.exec<{ data: string }>(`SELECT data FROM contents WHERE id = ?`, id).one().data;
      expect(payload).toContain(`"hash":"${sha256Hex(data)}"`);
      expect(() => storage.sql.exec(`UPDATE contents SET data = '{}'`)).toThrow(/written once/);
      const m = get(s, id);
      expect([m.body, m.kind, isLive(m), m.pending]).toEqual(["一只橘猫，名字叫年糕。", KindFragment, true, true]);
    }));

  // Go's TestFormat1LogIsUpgraded is not ported: logs before format 3 are not
  // migrated on this platform (see LogFormatError).

  it("EraseDeletesWhatAMemorySaysForGood", async () => {
    const stub = freshObject();
    const marks = ["zq7secret9x", "qx4gistmark", "outcomemark5k", "lessonmark8w", "peoplemark2j", "pointermark6h", "私事", "地址"];
    const gone = await inObject(stub, (s, storage) => {
      s.setParams(testParams());
      const sess = session(s, t0, "", "cli");
      const keep = remember(s, t0, sess, "用户问了天气", "聊了几句。");
      const gone = rememberWith(s, {
        sessionId: sess, gist: "用户告诉我一件私事 qx4gistmark", body: "他说了地址 zq7secret9x，后来让我删掉。",
        outcome: "outcomemark5k", lesson: "lessonmark8w", people: ["peoplemark2j"], pointer: "pointermark6h",
      });
      const n = get(s, gone).n;
      s.saveVectors({ model: "model-x", dims: 2 }, [{ n, vec: [0.6, 0.8] }]);
      expect(s.storedVectorNs()).toEqual([n]);
      fill(s, sess, 3);
      // The keyword index holds the words before the erasure: the scan below
      // would see them.
      expect(tablesHolding(storage, ["7secret9x"])).toEqual(["contents", "memories", "memories_fts_data"]);

      expect(s.erase(t0 + hour, sess, gone, "the user asked me to delete it")).toBe(n);
      // Not a byte of it is left in the database, the keyword index included.
      // Looked at before anything else, since a rebuild empties the index.
      // The index stores a word after the part it shares with the word before
      // it, so the latin words are also looked for without their first two
      // letters.
      const tails = marks.filter((w) => /^[a-z0-9]+$/.test(w)).map((w) => w.slice(2));
      expect(tablesHolding(storage, [...marks, ...tails])).toEqual([]);
      expect(tablesHolding(storage, ["天气"]), "the scan is not looking at the text").toContain("contents");
      const m = get(s, gone);
      expect([m.state, isLive(m), m.gist, m.body, m.outcome, m.lesson, m.people, m.pointer])
        .toEqual([StateErased, false, "", "", "", "", [], ""]);
      // It was lived through: it keeps its place, and the clock does not move.
      expect([m.ord, s.clock(), m.createdAt]).toEqual([2, 5, t0]);
      for (const q of ["私事", "地址", "zq7secret9x", "qx4gistmark"]) expect(search(s, q, true), q).toEqual([]);
      expect(recentIDs(s)).not.toContain(gone);
      expect(recentIDs(s)).toContain(keep);
      expect(tierTotal(s.tierCounts(s.clock()))).toBe(4);
      expect(s.storedVectorNs()).toEqual([]);
      // The log says that it existed and that it was erased, and why.
      expect(storage.sql.exec(`SELECT json_extract(payload, '$.reason') AS r FROM events WHERE kind = 'erase'`).one().r)
        .toBe("the user asked me to delete it");
      replays(s, storage);

      // There is nothing left to erase or amend.
      expect(thrown(() => s.erase(t0, sess, gone, ""))).toBeInstanceOf(ErasedError);
      expect(thrown(() => s.amend(t0, sess, AmendPin, gone, 0, ""))).toBeInstanceOf(ErasedError);
      expect(thrown(() => s.erase(t0, sess, "m_nothing", ""))).toBeInstanceOf(NoMemoryError);
      expect(thrown(() => s.erase(t0, "s_nothing", keep, ""))).toBeInstanceOf(NoSessionError);

      // And still none after the rebuild.
      expect(tablesHolding(storage, [...marks, ...tails])).toEqual([]);
      return gone;
    });

    // A memory without the content replays to the same thing.
    await evictDurableObject(stub);
    await inObject(stub, (s, storage) => {
      const m = get(s, gone);
      expect([m.state, m.ord]).toEqual([StateErased, 2]);
      replays(s, storage);
    });
  });

  it("RetractSetsAsideAndRestoreBringsBack", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "", "cli");
      const id = remember(s, t0, sess, "用户给我看了他的猫", "一只橘猫，名字叫年糕。");
      fill(s, sess, 2);

      amend(s, sess, AmendRetract, id);
      let m = get(s, id);
      expect([m.retracted, isLive(m), m.body !== ""]).toEqual([true, false, true]);
      for (const deep of [false, true]) expect(search(s, "年糕", deep), `deep=${deep}`).toEqual([]);
      expect(recentIDs(s)).not.toContain(id);
      expect(tierTotal(s.tierCounts(s.clock()))).toBe(2);
      replays(s, storage);

      fill(s, sess, 20);
      amend(s, sess, AmendRestore, id);
      // Restored, it is within reach again: being amended is coming to mind.
      m = get(s, id);
      expect([m.retracted, m.touchedOrd, tierOf(m, s.clock()), m.strength]).toEqual([false, 23, "active", 10]);
      expect(search(s, "年糕")).toEqual([id]);
      replays(s, storage);
    }));

  it("PinAndReweigh", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "", "cli");
      const pinned = remember(s, t0, sess, "要记牢的事", "正文");
      const light = remember(s, t0, sess, "没那么重要的事", "正文");
      const heavy = remember(s, t0, sess, "后来才知道重要的事", "正文");

      amend(s, sess, AmendPin, pinned);
      amend(s, sess, AmendReweigh, light, 0.25); // half the importance: half the strength
      amend(s, sess, AmendReweigh, heavy, 0.9); // over the core threshold
      fill(s, sess, 60);
      const now = s.clock();

      let m = get(s, pinned);
      expect([m.pinned, m.core, tierOf(m, now), m.fadeAt]).toEqual([true, true, "core", 0]);
      m = get(s, light);
      expect([m.importance, tierOf(m, now)]).toEqual([0.25, "archived"]);
      near(m.strength, 5, 1e-9);
      m = get(s, heavy);
      expect([m.importance, m.core]).toEqual([0.9, true]);
      near(m.strength, 10 * Math.pow(4, 0.8), 1e-9);
      const core = s.core(10);
      expect([core.length, core[0]!.id]).toEqual([2, pinned]);
      replays(s, storage);

      // Unpinned, it fades like any other memory from here on.
      s.amend(t0 + 2 * hour, sess, AmendUnpin, pinned, 0, "");
      m = get(s, pinned);
      expect([m.pinned, m.core, m.touchedOrd, tierOf(m, now)]).toEqual([false, false, now, "active"]);
      // Not in Go: its decay starts over from the clock now, and the session
      // that asked was active.
      near(m.fadeAt, now + 10 * Math.log(1 / 0.3), 1e-9);
      near(m.archiveAt, now + 10 * Math.log(1 / 0.05), 1e-9);
      expect(s.session(sess)!.lastActiveAt).toBe(t0 + 2 * hour);
      fill(s, sess, 13);
      expect(tierOf(get(s, pinned), s.clock())).toBe("faded");
      // Brought back under the threshold, the other one fades again too.
      amend(s, sess, AmendReweigh, heavy, 0.5);
      m = get(s, heavy);
      expect(m.core).toBe(false);
      near(m.strength, 10, 1e-9);

      expect(thrown(() => s.amend(t0, sess, AmendPin, "m_nothing", 0, ""))).toBeInstanceOf(NoMemoryError);
      expect(thrown(() => s.amend(t0, "s_nothing", AmendPin, pinned, 0, ""))).toBeInstanceOf(NoSessionError);
      expect(thrown(() => s.amend(t0, sess, "polish", pinned, 0, "")).message).toBe(`unknown amend action "polish"`);
      // Preferences are not set through amend.
      expect(thrown(() => s.amend(t0, sess, "prefer", pinned, 0, "")).message).toBe(`unknown amend action "prefer"`);
      replays(s, storage);
    }));

  it("CorrectionReplacesWithoutRewriting", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "model-a", "cli");
      const old = remember(s, t0, sess, "用户的猫叫年糕", "一只橘猫。");
      fill(s, sess, 4);
      const later = session(s, t0 + 48 * hour, "model-b", "desktop");

      const id = s.correct(t0 + 48 * hour, old, {
        sessionId: later, moment: "other", source: "lived", importance: 0.5,
        gist: "用户的猫叫汤圆", body: "一只橘猫。我之前记成了年糕。", happened: t0,
      });
      const was = get(s, old);
      const is = get(s, id);
      expect([was.state, was.stateBy, isLive(was), was.gist]).toEqual([StateSuperseded, id, false, "用户的猫叫年糕"]);
      expect([isLive(is), is.corrects, is.kind, is.model, is.createdAt, is.writtenAt])
        .toEqual([true, old, KindFragment, "model-b", t0, t0 + 48 * hour]);
      // A correction adds nothing to what was lived through.
      expect([s.clock(), is.ord, is.touchedOrd]).toEqual([5, 5, 5]);
      expect(search(s, "橘猫")).toEqual([id]);
      expect(search(s, "橘猫", true)).toHaveLength(2);
      expect(recentIDs(s)).not.toContain(old);
      replays(s, storage);

      const input = { sessionId: sess, moment: "", source: "", importance: 0, gist: "g", body: "b" };
      const err = thrown(() => s.correct(t0, old, input));
      expect(err).toBeInstanceOf(SupersededError);
      expect(err.message).toContain(id);
      expect(thrown(() => s.correct(t0, "m_nothing", input))).toBeInstanceOf(NoMemoryError);
      // The correction can be corrected in turn.
      const again = s.correct(t0, id, { sessionId: sess, moment: "other", source: "lived", importance: 0.5, gist: "用户的猫叫元宵", body: "一只橘猫。" });
      expect([get(s, id).stateBy, get(s, old).stateBy]).toEqual([again, id]);
    }));

  it("Preferences", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "", "cli");
      const a = s.addPreference(t0, sess, "不用记天气之类的闲聊", 2);
      const b = s.addPreference(t0 + minute, sess, "用户改主意的时候要记", 2);
      expect(thrown(() => s.addPreference(t0, sess, "第三条", 2))).toBeInstanceOf(TooManyPreferencesError);
      expect(thrown(() => s.addPreference(t0, "s_nothing", "x", 2))).toBeInstanceOf(NoSessionError);
      let ps = s.preferences();
      expect(ps.map((p) => [p.id, p.text])).toEqual([[a, "不用记天气之类的闲聊"], [b, "用户改主意的时候要记"]]);
      expect(a).toMatch(/^p_[a-z2-9]{8}$/);
      expect(s.clock(), "a preference advanced the clock").toBe(0);

      s.retirePreference(t0 + hour, sess, a, "the user changed their mind");
      expect(thrown(() => s.retirePreference(t0, sess, a, ""))).toBeInstanceOf(NoPreferenceError);
      ps = s.preferences();
      expect(ps.map((p) => p.id)).toEqual([b]);
      // Room again.
      s.addPreference(t0, sess, "第三条", 2);
      replays(s, storage);
    }));

  // Only a moment written as it happens moves the clock. What is written
  // about the past afterwards does not push other memories away.
  it("ReconstructedMemoriesDoNotMoveTheClock", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "", "cli");
      const lived = remember(s, t0, sess, "今天发生的事", "正文");
      fill(s, sess, 4); // clock 5

      // Four hundred accounts of the past, written in one go.
      let first = "", last = "";
      for (let i = 0; i < 400; i++) {
        const when = t0 + (i - 400) * day;
        const { id, dup } = s.remember(t0, {
          sessionId: sess, moment: "other", source: SourceReconstructed, importance: 0.5,
          gist: "旧会话 " + isoDay(when), body: "从记录里整理出来的。", happened: when,
        });
        expect(dup).toBe(false);
        if (i === 0) first = id;
        last = id;
      }
      const now = s.clock();
      expect(now, "reconstructed memories must not advance the clock").toBe(5);
      // Nothing that was there has been pushed away, and none of the new ones
      // arrived already faded: they all count from the moment they were written.
      expect(tierOf(get(s, lived), now)).toBe("active");
      expect(s.tierCounts(now)).toEqual({ core: 0, active: 405, faded: 0, archived: 0 });
      const m = get(s, first);
      expect([m.ord, m.touchedOrd, m.source, m.pending, m.createdAt, m.writtenAt])
        .toEqual([5, 5, SourceReconstructed, true, t0 - 400 * day, t0]);
      near(m.strength, 10, 1e-9);
      // Listed by when things happened, not by when they were written down.
      const all = s.recent(now, 1000);
      expect(all).toHaveLength(405);
      expect([all[5]!.id, all[404]!.id]).toEqual([last, first]);
      expect(all.slice(0, 5).map((x) => x.id)).toContain(lived);

      // A retried write of the same account is not stored twice.
      const again = s.remember(t0 + minute, {
        sessionId: sess, moment: "other", source: SourceReconstructed, importance: 0.5,
        gist: "旧会话 " + isoDay(t0 - day), body: "从记录里整理出来的。", happened: t0 - day,
      });
      expect(again).toEqual({ id: last, dup: true });

      // From here on they fade with what is lived, like anything else.
      fill(s, sess, 13);
      const c = s.tierCounts(s.clock());
      expect([c.faded, c.active]).toEqual([405, 13]);
      replays(s, storage);
    }));
});

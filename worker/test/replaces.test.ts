// A lesson or an impression written back by reflect can take the place of
// earlier ones of its kind (replaces). New on this platform: Go replaces an
// impression by a newer one of the same about, and nothing else.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type EntryRequest, MaxReplaces } from "../src/memory/amend";
import type { Memory as MemoryObject } from "../src/memory-object";
import { AmendPin, AmendRetract } from "../src/store/amend";
import { KindEpisode, KindImpression, KindLesson, KindSelf, StateSuperseded } from "../src/store/content";
import { SupersededError } from "../src/store/errors";
import { amend, ent, entry, reflectOn, refused, replays, thrown } from "./amend-helpers";
import { dump, get, remember, search, session, t0, withStore } from "./helpers";
import { adminSecret, Client, createMemory, fetchWorker, freshName, idIn, setClock } from "./mcp-helpers";
import { isInvalid, ok, start } from "./service-helpers";

const lesson = (gist: string, from: string[], replaces: string[] = []) => ({ ...ent(KindLesson, gist, ...from), replaces });
const impression = (gist: string, about: string, from: string[], replaces: string[] = []) =>
  ({ ...ent(KindImpression, gist, ...from), about, replaces });

function payloadOf(storage: DurableObjectStorage, id: string): Record<string, unknown> {
  const p = storage.sql
    .exec<{ payload: string }>(`SELECT payload FROM events WHERE kind = 'remember' AND json_extract(payload, '$.id') = ?`, id)
    .one().payload;
  return JSON.parse(p) as Record<string, unknown>;
}

describe("replaces", () => {
  it("marks earlier lessons replaced by the new one: kept, out of ordinary recall, reached by a deep one", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "", "cli");
      const f1 = remember(s, t0, sess, "片段一", "正文");
      const f2 = remember(s, t0, sess, "片段二", "正文");
      const [old1, old2, other] = reflectOn(s, sess, [
        lesson("先问清楚再动手 kappaword", [f1]), lesson("动手前先问 kappaword", [f2]), lesson("别的经验", [f1]),
      ]);
      expect(search(s, "kappaword").sort()).toEqual([old1, old2].sort());
      const clock = s.clock();
      const [now] = reflectOn(s, sess, [lesson("动手前先问清楚要什么", [f1, f2], [old1!, old2!])]);
      for (const id of [old1!, old2!]) {
        const m = get(s, id);
        expect([m.state, m.stateBy, m.gist !== ""]).toEqual([StateSuperseded, now, true]);
      }
      expect(get(s, other!).state).toBe("");
      expect(search(s, "kappaword")).toEqual([]);
      expect(search(s, "kappaword", true).sort()).toEqual([old1, old2].sort());
      // The log names them, and the clock did not move.
      expect(payloadOf(storage, now!).replaces).toEqual([old1, old2]);
      expect(s.clock()).toBe(clock);
      // A replaced lesson is not pinned, and not replaced again.
      expect(thrown(() => amend(s, sess, AmendPin, old1!))).toBeInstanceOf(SupersededError);
      expect(refused(s, sess, lesson("又一条", [f1], [old1!]))).toBe(
        `entry 1: ${old1} in replaces has already been replaced, by ${now}: name that one`,
      );
      replays(s, storage);
      expect(s.check().findings.filter((x) => x.level === "problem")).toEqual([]);
    }));

  it("lets an impression take the place of one held under another name, with those of its own name", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "", "cli");
      const f = remember(s, t0, sess, "片段", "正文");
      const [alias, same] = reflectOn(s, sess, [impression("话少", "小林", [f]), impression("细心", "林工", [f])]);
      const [now] = reflectOn(s, sess, [impression("话少但细心", "林工", [f], [alias!])]);
      // What it is about comes first, then what was named.
      expect(payloadOf(storage, now!).replaces).toEqual([same, alias]);
      expect([get(s, alias!).stateBy, get(s, same!).stateBy]).toEqual([now, now]);
      expect(s.impressions(["小林", "林工"]).map((m) => m.id)).toEqual([now]);
      // One that is both of its name and named is in the log once.
      const [again] = reflectOn(s, sess, [impression("比以前更细心", "林工", [f], [now!])]);
      expect(payloadOf(storage, again!).replaces).toEqual([now]);
      replays(s, storage);
    }));

  it("refuses what cannot be taken the place of, saying why, and writes nothing", () =>
    withStore((s) => {
      const sess = session(s, t0, "", "cli");
      const f = remember(s, t0, sess, "片段", "正文");
      const gone = remember(s, t0, sess, "要删的片段", "正文");
      const [l1, l2, l3, imp, ep] = reflectOn(s, sess, [
        lesson("经验一", [f]), lesson("经验二", [f]), lesson("经验三", [f]), impression("印象", "某人", [f]),
        ent(KindEpisode, "经历", gone),
      ]);
      const [erasedLesson] = reflectOn(s, sess, [lesson("要删的经验", [f])]);
      s.erase(t0, sess, erasedLesson!, "");
      amend(s, sess, AmendRetract, l2!);
      reflectOn(s, sess, [lesson("新经验", [f], [l3!])]);
      const cases: [string, ReturnType<typeof lesson>, string][] = [
        ["another kind", lesson("x", [f], [imp!]), `${imp} in replaces is a impression: a lesson takes the place of earlier lessons only`],
        ["an episode", lesson("x", [f], [ep!]), `${ep} in replaces is a episode: a lesson takes the place of earlier lessons only`],
        ["a fragment", impression("x", "某人", [f], [f]), `${f} in replaces is a fragment: a impression takes the place of earlier impressions only`],
        ["an erased one", lesson("x", [f], [erasedLesson!]), `${erasedLesson} in replaces has been erased`],
        ["a retracted one", lesson("x", [f], [l2!]), `${l2} in replaces has been retracted: restore it first, or leave it out`],
        ["one already replaced", lesson("x", [f], [l3!]), `${l3} in replaces has already been replaced`],
        ["nothing", lesson("x", [f], ["m_nothing"]), "m_nothing in replaces names no memory"],
      ];
      for (const [name, e, want] of cases) expect(refused(s, sess, e), name).toContain(want);
      // Two entries of one round may not both name it.
      expect(refused(s, sess, lesson("x", [f], [l1!]), lesson("y", [f], [l1!]))).toBe(
        `entry 2: ${l1} is named in replaces by an earlier entry of this round`,
      );
      expect(get(s, l1!).state).toBe("");
    }));

  it("refuses an id named twice, a statement about oneself, other kinds and too many ids, before the memory is read", () =>
    start((f) => {
      const x = f.remember("一件事", "正文");
      const v = ok(f.obj.beginReflect({ sessionId: f.sess() }));
      const finish = (e: EntryRequest) => {
        const r = f.obj.finishReflect({ sessionId: f.sess(), batch: v.batch, entries: [e] });
        return isInvalid(r) ? r.invalid : "written";
      };
      expect(finish({ kind: KindLesson, gist: "g", body: "b", from: [x], replaces: ["m_a", " m_a "] })).toBe(
        "m_a is named twice in replaces (entry 1)",
      );
      expect(finish({ kind: KindSelf, gist: "g", from: [x], replaces: ["m_a"] })).toBe(
        "replaces is not for a statement about yourself: to revise one, name it in ref (entry 1)",
      );
      for (const kind of [KindEpisode, "reading"]) {
        expect(finish({ kind, gist: "g", body: "b", from: [x], ref: x, replaces: ["m_a"] }), kind).toBe(
          "replaces goes with a lesson or an impression only (entry 1)",
        );
      }
      const many = Array.from({ length: MaxReplaces + 1 }, (_, i) => `m_${i}`);
      expect(finish({ kind: KindLesson, gist: "g", body: "b", from: [x], replaces: many })).toBe("at most 10 ids in replaces (entry 1)");
      // Blank ids are left out, as in from.
      expect(finish({ kind: KindEpisode, gist: "g", body: "b", from: [x], replaces: [" ", ""] })).toBe("written");
    }));

  it("lets a lesson rest on what the lessons it replaces rest on, merged with its own from and capped", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "", "cli");
      const fs = Array.from({ length: 24 }, (_, i) => remember(s, t0, sess, `片段 ${i}`, "正文"));
      const [a, b] = reflectOn(s, sess, [lesson("经验甲", [fs[0]!, fs[1]!, fs[2]!]), lesson("经验乙", [fs[2]!, fs[3]!])]);
      // What can no longer be built on is not taken over.
      s.erase(t0, sess, fs[1]!, "");
      const [merged] = reflectOn(s, sess, [{ ...lesson("合起来的经验", [], [a!, b!]) }]);
      expect(s.sources(merged!)).toEqual([fs[0], fs[2], fs[3]]);
      expect(payloadOf(storage, merged!).from).toEqual([fs[0], fs[2], fs[3]]);
      // With from given: its own first, then what is taken over, at most 20.
      const [c] = reflectOn(s, sess, [lesson("经验丙", fs.slice(4, 22))]);
      const [both] = reflectOn(s, sess, [lesson("又合起来", [fs[22]!, fs[0]!], [merged!, c!])]);
      expect(payloadOf(storage, both!).from).toEqual([fs[22], fs[0], fs[2], fs[3], ...fs.slice(4, 20)]);
      // Nothing left to rest on is refused as a lesson without from is.
      const [bare] = reflectOn(s, sess, [lesson("只靠一条", [fs[23]!])]);
      s.erase(t0, sess, fs[23]!, "");
      expect(refused(s, sess, lesson("无所依", [], [bare!]))).toBe("entry 1: from is required: the ids of the memories this rests on");
      // An impression still needs its own.
      const [imp] = reflectOn(s, sess, [impression("印象", "某人", [fs[0]!])]);
      expect(refused(s, sess, impression("新印象", "别人", [], [imp!]))).toContain("from is required");
      replays(s, storage);
    }));

  it("is shown both ways by expand, and a correction is not counted as one", () =>
    start((f) => {
      const x = f.remember("一件事", "正文");
      const write = (entries: EntryRequest[]): string[] => {
        const v = ok(f.obj.beginReflect({ sessionId: f.sess() }));
        return ok(f.obj.finishReflect({ sessionId: f.sess(), batch: v.batch, entries }));
      };
      const [l1, l2] = write([
        { kind: KindLesson, gist: "经验一", body: "正文", from: [x] }, { kind: KindLesson, gist: "经验二", body: "正文", from: [x] },
      ]);
      const [l3] = write([{ kind: KindLesson, gist: "经验三", body: "正文", replaces: [l1!, l2!] }]);
      const text = (id: string) => {
        const r = f.obj.answer({ tool: "expand", ids: [id] });
        if (!("text" in r)) expect.fail("expand");
        return r.text;
      };
      expect(text(l3!)).toContain(`\nreplaces: ${l1}, ${l2}\n`);
      expect(text(l3!)).toContain(`\nbuilt on: ${x}\n`);
      expect(text(l1!)).toContain(`· replaced by ${l3}`);
      // A corrected lesson shows what it corrects, not what it replaces.
      const fixed = /m_[a-z0-9]+/.exec(ok(f.obj.amend({ sessionId: f.sess(), action: "correct", id: l3!, gist: "经验三，改过" })))![0];
      expect(text(fixed)).toContain(`\ncorrects: ${l3}\n`);
      expect(text(fixed)).not.toContain("replaces:");
      expect(text(l3!)).toContain(`\nreplaces: ${l1}, ${l2}\n`);
    }));

  it("does not show a revised statement about oneself as replaced: that is what revises says", () =>
    start((f) => {
      const a = session(f.st, t0, "", "cli");
      const b = session(f.st, t0, "", "cli");
      const x = [
        remember(f.st, t0, a, "一", "正文"), remember(f.st, t0, a, "二", "正文"), remember(f.st, t0, b, "三", "正文"),
        remember(f.st, t0, b, "四", "正文"), remember(f.st, t0, a, "五", "正文"),
      ];
      const self = (gist: string, ref: string, ...from: string[]) =>
        entry({ kind: KindSelf, gist, context: "某种场合", importance: 0.5, from, ref });
      const [first] = reflectOn(f.st, a, [self("我是这样的", "", x[0]!, x[1]!, x[2]!)]);
      const [second] = reflectOn(f.st, a, [self("我其实是那样的", first!, x[2]!, x[3]!, x[4]!)]);
      expect(f.get(first!).stateBy).toBe(second);
      expect(f.expand(second!).replaced).toEqual([]);
    }));

  it("is passed through the tool, and travels in an export and an import", async () => {
    const m = await createMemory();
    await setClock(m.name, t0);
    const c = new Client("new", m);
    const s = idIn(await c.ok("get_context", {}), "s_");
    const x = idIn(await c.ok("remember", { session_id: s, gist: "一件事", body: "正文" }));
    let batch = idIn(await c.ok("reflect", { session_id: s }), "b_");
    const [old] = [...(await c.ok("reflect", {
      session_id: s, batch, entries: [{ kind: "lesson", gist: "旧的经验", body: "正文", from: [x] }],
    })).matchAll(/m_[a-z0-9]+/g)].map((r) => r[0]);
    await c.ok("remember", { session_id: s, gist: "又一件事", body: "正文" });
    batch = idIn(await c.ok("reflect", { session_id: s }), "b_");
    const [now] = [...(await c.ok("reflect", {
      session_id: s, batch, entries: [{ kind: "lesson", gist: "新的经验", body: "正文", replaces: [old] }],
    })).matchAll(/m_[a-z0-9]+/g)].map((r) => r[0]);
    expect(await c.ok("expand", { ids: [now] })).toContain(`replaces: ${old}\n`);

    const headers = { authorization: `Bearer ${adminSecret}` };
    const file = await (await fetchWorker(`/admin/memories/${m.name}/export`, { headers })).text();
    expect(file).toContain(`"replaces":["${old}"]`);
    const to = freshName();
    const res = await fetchWorker(`/admin/memories/${to}/import`, { method: "POST", headers, body: file });
    expect(res.status).toBe(201);
    const [a, b] = await Promise.all([m.name, to].map((n) =>
      runInDurableObject(env.MEMORY.getByName(n), (obj: MemoryObject, state) => ({
        dump: dump(obj.store, state.storage).split("\n"),
        problems: obj.check().findings.filter((x) => x.level === "problem"),
        old: obj.store.get([old!])[0]!.stateBy,
        restoreAt: state.storage.sql.exec<{ at: number }>(`SELECT COALESCE(MAX(at), 0) AS at FROM restores`).one().at,
      }))));
    expect([a!.old, b!.old]).toEqual([now, now]);
    expect([a!.problems, b!.problems]).toEqual([[], []]);
    expect(b!.dump.filter((l) => !l.startsWith(`[${b!.restoreAt},`))).toEqual(a!.dump);
  });

  it("names nothing: check reports the link as broken", () =>
    withStore((s, storage) => {
      const sess = session(s, t0, "", "cli");
      const f = remember(s, t0, sess, "片段", "正文");
      const [l] = reflectOn(s, sess, [lesson("经验", [f])]);
      expect(s.check().findings.filter((x) => x.level === "problem")).toEqual([]);
      // A log changed by hand: the lesson's event names a lesson that never was.
      const seq = storage.sql.exec<{ seq: number }>(`SELECT seq FROM events WHERE json_extract(payload, '$.id') = ?`, l!).one().seq;
      storage.sql.exec(`DROP TRIGGER events_no_update`);
      storage.sql.exec(`UPDATE events SET payload = json_set(payload, '$.replaces', json('["m_nothing"]')) WHERE seq = ?`, seq);
      s.rebuild();
      const broken = s.check().findings.find((x) => x.code === "link-broken");
      expect(broken?.ids).toEqual([l]);
    }));
});

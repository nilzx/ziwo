// Export and import: byte for byte against what the Go build wrote, exports
// of either build coming back, damaged files refused without a trace, a
// round trip of a memory with every kind of event, and the size limit.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryRequest } from "../src/memory/amend";
import { maxBytesInOneGo, maxEventsInOneGo, type Memory as MemoryObject } from "../src/memory-object";
import { reportText } from "../src/store/check";
import { defaultParams } from "../src/store/decay";
import { chain, goCompact } from "../src/store/export";
import type { Entry } from "../src/store/reflect";
import type { Store } from "../src/store/store";
import { goReference as go } from "./go-export";
import { dump, minute, t0 } from "./helpers";
import { adminSecret, Client, createMemory, fetchWorker, freshName, idIn, setClock } from "./mcp-helpers";
import { isInvalid, ok } from "./service-helpers";

const refToken = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
const at = (m: number): number => t0 + m * minute;

function admin(path: string, init: { method?: string; body?: string; accept?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${adminSecret}` };
  if (init.accept !== undefined) headers.accept = init.accept;
  return fetchWorker(path, { method: init.method ?? "GET", headers, body: init.body });
}

const importAs = (name: string, file: string) => admin(`/admin/memories/${name}/import`, { method: "POST", body: file });

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function tablesOf(name: string): Promise<string[]> {
  return runInDurableObject(env.MEMORY.getByName(name), (_obj: MemoryObject, state) =>
    state.storage.sql
      .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`)
      .toArray()
      .map((r) => r.name),
  );
}

function inMemory<R>(name: string, fn: (obj: MemoryObject, storage: DurableObjectStorage) => R): Promise<R> {
  return runInDurableObject(env.MEMORY.getByName(name), (obj: MemoryObject, state) => fn(obj, state.storage));
}

function entry(e: Partial<Entry> & { kind: string; gist: string }): Entry {
  return {
    body: "", outcome: "", feeling: "", intensity: 0, lesson: "", people: [], pointer: "", importance: 0.5,
    about: "", context: "", from: [], ref: "", milestone: false, ...e,
  };
}

// refLife makes the calls the Go reference made (refLife in the Go test),
// with the same strings at the same times, and returns the ids under the
// same names.
function refLife(s: Store): Record<string, string> {
  const ids: Record<string, string> = {};
  const lived = { moment: "other", source: "lived", importance: 0.5 };
  ids.sa = s.startSession(at(0), "model-a", "cli").session.id;
  ids.sb = s.startSession(at(60), "model-b", "desktop").session.id;
  const a = ids.sa;
  const b = ids.sb;
  ids.f1 = s.remember(at(1), { ...lived, sessionId: a, gist: "exportmark one <a&b>", body: 'line one\nline "two"   end' }).id;
  ids.f2 = s.remember(at(2), { ...lived, sessionId: a, gist: "导出 second", body: "第二条 😀" }).id;
  ids.f3 = s.remember(at(3), { ...lived, sessionId: b, gist: "third gist", body: "third body" }).id;
  ids.f4 = s.remember(at(4), { ...lived, sessionId: b, gist: "erased gist", body: "erasedmark body" }).id;
  ids.rich = s.remember(at(5), {
    sessionId: b, moment: "emotion", source: "told", importance: 0.9, intensity: 0.4, gist: "rich gist", body: "rich body",
    outcome: "rich outcome", feeling: "rich feeling", lesson: "rich lesson", people: ["Ann"], pointer: "https://example.com/x?a=1&b=2",
  }).id;
  ids.old = s.remember(at(6), {
    sessionId: a, moment: "other", source: "reconstructed", importance: 0.5, gist: "old project", body: "from the notes",
    happened: Date.UTC(2026, 4, 11, 8, 0, 0),
  }).id;
  ids.fixed = s.correct(at(7), ids.f2, { ...lived, sessionId: a, gist: "导出 second, corrected", body: "第二条 😀" });
  s.erase(at(8), b, ids.f4, "the user asked");
  ids.p1 = s.addPreference(at(9), a, "keep <only> what & matters", 30);
  ids.p2 = s.addPreference(at(10), a, "a rule to drop", 30);
  s.retirePreference(at(11), a, ids.p2, "the user asked");
  s.logRecalls([
    { at: at(12), session: a, query: "exportmark <q>", ids: [ids.f1, ids.f3] },
    { at: at(13), session: b, read: true, ids: [ids.f3] },
  ]);
  s.amend(at(14), b, "pin", ids.f3, 0, "the user asked");
  s.amend(at(14), b, "reweigh", ids.rich, 0.3, "the user asked");
  s.amend(at(14), b, "retract", ids.old, 0, "the user asked");
  s.amend(at(14), b, "restore", ids.old, 0, "the user asked");
  ids.batch = s.beginReflect(at(15), a, 15 * minute);
  const made = s.finishReflect(at(16), a, ids.batch, [
    entry({ kind: "episode", gist: "episode gist", body: "episode body", from: [ids.f1, ids.fixed] }),
    entry({ kind: "impression", gist: "impression gist", about: "Ann", from: [ids.rich] }),
    entry({ kind: "self", gist: "self gist", context: "when designing", from: [ids.f1, ids.fixed, ids.f3] }),
    entry({ kind: "reading", gist: "reading gist", ref: ids.old }),
  ], [ids.old]);
  made.forEach((id, i) => (ids[`w${i}`] = id));
  s.setTokenHash(refToken);
  return ids;
}

// template replaces ids, the instance and the hashes of the chain, which
// differ between two runs of the same calls.
function template(file: string, ids: Record<string, string>, instance: string): string {
  let out = file.replaceAll(instance, "{instance}");
  for (const [name, id] of Object.entries(ids).sort((x, y) => y[1].length - x[1].length)) out = out.replaceAll(id, `{${name}}`);
  return out.replace(/"(chain|head)":"[0-9a-f]{64}"/g, '"$1":"{hash}"');
}

// loadRows puts the Go reference's rows into the memory called name, as
// they are: the same log, contents, instance and token hash.
function loadRows(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  for (const [seq, when, kind, payload] of go.rows.events) {
    sql.exec(`INSERT INTO events(seq, at, kind, payload) VALUES(?, ?, ?, ?)`, seq, when, kind, payload);
  }
  for (const [id, data] of go.rows.contents) sql.exec(`INSERT INTO contents(id, data) VALUES(?, ?)`, id, data);
  sql.exec(`UPDATE meta SET value = ? WHERE key = 'instance'`, go.rows.instance);
  sql.exec(`UPDATE meta SET value = ? WHERE key = 'token_sha256'`, go.rows.token);
}

// lines builds an export from events whose chain this test computes.
function exportOf(events: { seq: number; at: number; kind: string; payload: string; content?: string }[], footer?: string): string {
  let prev = "";
  let out = `{"ziwo_export":1,"log_format":3,"instance":"i_handmade","exported_at":${t0}}\n`;
  for (const e of events) {
    prev = chain(prev, e.seq, e.at, e.kind, e.payload, e.content);
    out += `{"seq":${e.seq},"at":${e.at},"kind":"${e.kind}","payload":${e.payload}`;
    if (e.content !== undefined) out += `,"content":${JSON.stringify(e.content)}`;
    out += `,"chain":"${prev}"}\n`;
  }
  return out + (footer ?? `{"end":true,"events":${events.length},"head":"${prev}"}\n`);
}

describe("export", () => {
  it("writes byte for byte what the Go build wrote for the same log and contents", async () => {
    const m = await createMemory();
    await inMemory(m.name, (obj, storage) => {
      obj.store; // builds the tables
      loadRows(storage);
      obj.now = () => go.exportedAt;
    });
    const res = await admin(`/admin/memories/${m.name}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${m.name}-20261112-080000.ndjson"`);
    const text = await res.text();
    expect(text.length).toBe(go.export.length);
    expect(text).toBe(go.export);
  });

  it("writes what the Go build wrote for the same sequence of calls, apart from ids", async () => {
    const m = await createMemory();
    const { ids, instance } = await inMemory(m.name, (obj, storage) => {
      const ids = refLife(obj.store);
      obj.now = () => go.exportedAt;
      const instance = storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'instance'`).one().value;
      return { ids, instance };
    });
    // refLife set the token hash Go's run set.
    const file = await (await admin(`/admin/memories/${m.name}/export`)).text();
    expect(Object.keys(ids).sort()).toEqual(Object.keys(go.ids).sort());
    expect(template(file, ids, instance)).toBe(template(go.export, go.ids, go.rows.instance));
    // What the memories say is in the file, what was erased is not.
    expect(file).toContain("exportmark one");
    expect(file).not.toContain("erasedmark");
  });

  it("compacts a payload as Go's encoder does, and keeps its chain over the stored bytes", async () => {
    expect(goCompact(`{ "a" : "x <y> & z ", "b":[1, 2] }`)).toBe(`{"a":"x \\u003cy\\u003e \\u0026 z\\u2028","b":[1,2]}`);
    expect(goCompact(`{"a":"say \\" < \\\\"}`)).toBe(`{"a":"say \\" \\u003c \\\\"}`);
    // Go brought back a hand-made export whose first payload is not compact,
    // and exported it again: so does this build, to the byte.
    const name = freshName();
    await setClock(name, go.importedAt);
    expect((await importAs(name, go.hand)).status).toBe(201);
    await inMemory(name, (obj, storage) => {
      storage.sql.exec(`UPDATE meta SET value = ? WHERE key = 'instance'`, go.handInstance);
      obj.now = () => go.handExportedAt;
    });
    const again = await (await admin(`/admin/memories/${name}/export`)).text();
    expect(again).toBe(go.handReexport);
    // Go's re-export does not come back, in Go (handReimport) nor here.
    expect(go.handReimport).toBe("not a usable export: it was changed or damaged at event 1");
    const refused = await importAs(freshName(), again);
    expect(await refused.json()).toEqual({ error: go.handReimport });
  });

  it("answers 404 for a memory that does not exist, and stores nothing for it", async () => {
    const name = freshName();
    const res = await admin(`/admin/memories/${name}/export`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `no such memory: "${name}"` });
    expect(await tablesOf(name)).toEqual([]);
  });
});

describe("import", () => {
  it("brings back an export the Go build wrote, with Go's figures and no problem", async () => {
    const name = freshName();
    await setClock(name, go.importedAt);
    const res = await importAs(name, go.export);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      memory: name, endpoint: `/${name}/mcp`, memories: go.importMemories, events: go.importEvents,
      exportedAt: go.exportedAt, note: "It answers to the token it had when it was exported.",
    });
    const text = await (await admin(`/admin/memories/${name}/check`, { accept: "text/plain" })).text();
    expect(text).toBe(go.importCheck);
    const facts = await inMemory(name, (obj, storage) => ({
      token: obj.store.tokenHash(),
      events: storage.sql.exec<{ seq: number; at: number; kind: string; payload: string }>(`SELECT seq, at, kind, payload FROM events ORDER BY seq`).toArray(),
      contents: storage.sql.exec<{ id: string; data: string }>(`SELECT id, data FROM contents ORDER BY id`).toArray(),
      instance: storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'instance'`).one().value,
    }));
    expect(facts.token).toBe(go.rows.token);
    // Events keep their seq, at and payload; the restore is appended after.
    const last = go.rows.events.at(-1)!;
    expect(facts.events.slice(0, -1).map((e) => [e.seq, e.at, e.kind, e.payload])).toEqual(go.rows.events);
    expect(facts.events.at(-1)).toEqual({
      seq: last[0] + 1, at: go.importedAt, kind: "restore",
      payload: `{"from":"${go.rows.instance}","exported_at":${go.exportedAt},"events":${go.importEvents}}`,
    });
    expect(facts.contents.map((c) => [c.id, c.data])).toEqual(go.rows.contents);
    expect(facts.instance).toMatch(/^i_[a-z2-9]{8}$/);
    expect(facts.instance).not.toBe(go.rows.instance);
  });

  it("refuses what Go refuses, with Go's messages, and leaves no memory behind", async () => {
    const good = go.export;
    const lines = good.split(/(?<=\n)/);
    const footer = lines.at(-1)!;
    const cases: Record<string, string> = {
      cut: lines.slice(0, -3).join(""),
      changed: good.replace("third body", "third bodx"),
      footer: good.replace(footer, footer.replace(`"end":true,"events":`, `"end":true,"events":1`)),
      version: good.replace(`"ziwo_export":1`, `"ziwo_export":2`),
      newer: good.replace(`"log_format":3`, `"log_format":4`),
      empty: "",
      garbage: "hello\n",
    };
    for (const [what, file] of Object.entries(cases)) {
      const name = freshName();
      const res = await importAs(name, file);
      expect(res.status, what).toBe(400);
      expect(await res.json(), what).toEqual({ error: go.errors[what] });
      expect(await tablesOf(name), what).toEqual([]);
      expect((await admin(`/admin/memories/${name}`)).status, what).toBe(404);
    }
  });

  it("refuses an older log format, a log that cannot be replayed and a bad line as this build words them, leaving nothing", async () => {
    const good = go.export;
    const session = { seq: 1, at: t0, kind: "session", payload: `{"id":"s_aaaaaaaa"}` };
    const cases: [string, string, string][] = [
      ["older", go.export.replace(`"log_format":3`, `"log_format":2`), "log format 2 is older than 3 and is not migrated on this platform"],
      ["unknown kind", exportOf([session, { seq: 2, at: t0, kind: "bogus", payload: "{}" }]),
        `not a usable export: replay event 2: unknown event kind "bogus"`],
      ["payload not an object", exportOf([session, { seq: 2, at: t0, kind: "session", payload: "[1]" }]),
        "not a usable export: replay event 2: session: not a JSON object"],
      ["seq twice", exportOf([session, session]), "not a usable export: event 1: UNIQUE constraint failed: events.seq"],
      ["no kind", exportOf([{ ...session, kind: "" }]), "not a usable export: unreadable event"],
      ["seq not an integer", good.replace(`{"seq":1,`, `{"seq":1.0,`), "not a usable export: unreadable event"],
      ["a byte order mark", "﻿" + good, "not a usable export: unreadable line"],
      ["a second footer field wrong", good.replace(/"end":true,"events":(\d+)/, `"end":true,"events":"$1"`), "not a usable export: unreadable event"],
      ["a header that is not an object", "[1]\n" + good.split("\n").slice(1).join("\n"), "not a usable export: unreadable line"],
      ["its last event dropped and the count lowered",
        good.split(/(?<=\n)/).filter((_, i, all) => i !== all.length - 2).join("")
          .replace(`"events":${go.importEvents},`, `"events":${go.importEvents - 1},`),
        `not a usable export: it is incomplete: it holds ${go.importEvents - 1} events and says ${go.importEvents - 1}`],
      ["a content twice", exportOf([session,
        { seq: 2, at: t0, kind: "remember", payload: `{"id":"m_aaaaaaaa"}`, content: "{}" },
        { seq: 3, at: t0, kind: "remember", payload: `{"id":"m_aaaaaaaa"}`, content: "{}" }]),
        "not a usable export: event 3: UNIQUE constraint failed: contents.id"],
    ];
    for (const [what, file, message] of cases) {
      const name = freshName();
      const res = await importAs(name, file);
      expect(res.status, what).toBe(400);
      expect(await res.json(), what).toEqual({ error: message });
      expect(await tablesOf(name), what).toEqual([]);
    }
    // Keys are matched regardless of case and a last line needs no newline,
    // as Go reads them; a file with the replay refused can be imported again
    // under the same name once it is right.
    const name = freshName();
    expect((await importAs(name, exportOf([session, { seq: 2, at: t0, kind: "bogus", payload: "{}" }]))).status).toBe(400);
    // A null leaves a field at its zero value, as in Go: the chain is over 0.
    const relaxed = exportOf([{ ...session, at: 0 }]).replace(`{"seq":1,`, `{"SEQ":1,`).replace(`"at":0,`, `"at":null,`).replace(/\n$/, "");
    const res = await importAs(name, relaxed);
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    // The footer held no token: the answer carries a new one, which works.
    expect(body.token).toMatch(/^ziwo_[A-Za-z0-9_-]{43}$/);
    expect(body.note).toBe("The export held no token. This one is shown this once. Only its hash is stored.");
    const c = new Client("new", { name, token: body.token as string });
    expect(await c.ok("check", {})).toContain("1 sessions");
  });

  it("counts a table the runtime keeps for itself as nothing, and a log without a token as a memory", async () => {
    // wrangler dev keeps __miniflare_do_name in every object it names.
    const name = freshName();
    await inMemory(name, (_obj, storage) => storage.sql.exec(`CREATE TABLE __runtime_own (x TEXT)`));
    expect((await importAs(name, go.export)).status).toBe(201);
    const other = freshName();
    await inMemory(other, (_obj, storage) => storage.sql.exec(`CREATE TABLE events (seq INTEGER PRIMARY KEY)`));
    expect((await importAs(other, go.export)).status).toBe(409);
  });

  it("refuses a name that exists and leaves that memory as it was", async () => {
    const m = await createMemory();
    const before = await inMemory(m.name, (obj) => obj.store.counts());
    const res = await importAs(m.name, go.export);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: `memory "${m.name}" already exists` });
    expect(await inMemory(m.name, (obj) => obj.store.counts())).toEqual(before);
    expect((await importAs("Bad", go.export)).status).toBe(400);
  });
});

// A run like the generated one in scale.test.ts, smaller: every kind of
// event, through the object's methods.
function generatedLife(obj: MemoryObject, events: number): void {
  let seed = 424242;
  const r = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const words = ["猫", "部署", "纠正", "proxy", "天气", "alpha", "beta", "release", "<tag>", "a&b"];
  const phrase = () => `${pick(words)} ${pick(words)}`;
  let now = t0;
  obj.now = () => now;
  const sessions: string[] = [];
  const written: string[] = [];
  const prefs: string[] = [];
  for (let step = 0; obj.store.counts().events < events; step++) {
    now += Math.floor(r() * 20 * minute);
    const roll = r();
    if (sessions.length === 0 || roll < 0.05) {
      sessions.push(ok(obj.getContext({ model: pick(["model-a", "model-b", ""]), client: "cli", timezone: pick(["", "Asia/Shanghai"]) })).session.id);
    } else if (roll < 0.45) {
      const source = pick(["lived", "told", "reconstructed"]);
      const res = obj.remember({
        sessionId: pick(sessions), gist: `${phrase()} ${step}`, body: phrase(), source,
        happenedAt: source === "reconstructed" ? new Date(now - 1e9).toISOString() : undefined,
        importance: pick([0.2, 0.5, 0.95]), people: r() < 0.3 ? [pick(["阿明", "Ann"])] : undefined,
      });
      if (!isInvalid(res) && !res.dup) written.push(res.id);
    } else if (roll < 0.6) {
      ok(obj.recall({ query: phrase(), deep: r() < 0.3, sessionId: pick(sessions) }));
    } else if (roll < 0.7) {
      ok(obj.expand({ ids: [pick(written.length > 0 ? written : ["m_unknown"])], sessionId: pick(sessions) }));
    } else if (roll < 0.85 && written.length > 0) {
      const action = pick(["retract", "restore", "pin", "unpin", "reweigh", "correct", "prefer", "unprefer"]);
      const res = obj.amend({
        sessionId: pick(sessions), action, id: action === "unprefer" ? pick([...prefs, "p_gone"]) : pick(written),
        importance: 0.6, text: `规则 ${phrase()}`, gist: `${phrase()} 更正 ${step}`,
      });
      if (typeof res === "string") {
        const made = /^(?:preference saved as|corrected:) (\S+?);? /.exec(res);
        if (made !== null) (action === "prefer" ? prefs : written).push(made[1]!);
        if (action === "unprefer") prefs.splice(prefs.indexOf(res.split(" ")[1]!), 1);
      }
    } else if (roll < 0.9 && written.length > 0) {
      obj.erase({ sessionId: pick(sessions), id: pick(written) });
    } else {
      const sess = pick(sessions);
      const view = obj.beginReflect({ sessionId: sess, limit: 6 });
      if (isInvalid(view) || view.batch === "") continue;
      const frags = view.fragments.map((m) => m.id);
      const entries: EntryRequest[] = [];
      if (frags.length >= 2) entries.push({ kind: "episode", gist: `${phrase()} 经历`, body: phrase(), from: frags.slice(0, 2) });
      if (frags.length >= 1) entries.push({ kind: "impression", gist: `${phrase()} 印象`, about: "Ann", from: [frags[0]!] });
      if (frags.length >= 3 && r() < 0.5) entries.push({ kind: "self", gist: `${phrase()} 自述`, context: "c", from: frags.slice(0, 3) });
      if (written.length > 0 && r() < 0.5) entries.push({ kind: "reading", gist: `${phrase()} 理解`, ref: pick(written) });
      if (frags.length >= 2 && r() < 0.5) entries.push({ kind: "lesson", gist: `${phrase()} 经验`, body: phrase(), from: frags.slice(-2) });
      const made = obj.finishReflect({ sessionId: sess, batch: view.batch, entries, pass: frags.slice(3) });
      if (!isInvalid(made)) written.push(...made);
    }
  }
}

describe("a round trip", () => {
  it("brings a memory with every kind of event back the same, apart from the restore", async () => {
    const from = await createMemory();
    const kinds = await inMemory(from.name, (obj, storage) => {
      generatedLife(obj, 900);
      return storage.sql.exec<{ kind: string }>(`SELECT DISTINCT kind FROM events ORDER BY kind`).toArray().map((r) => r.kind);
    });
    expect(kinds).toEqual(["amend", "erase", "expand", "recall", "reflect", "remember", "session"]);
    const file = await (await admin(`/admin/memories/${from.name}/export`)).text();
    const to = freshName();
    const res = await importAs(to, file);
    expect(res.status).toBe(201);
    const restoreAt = await inMemory(to, (obj, storage) =>
      storage.sql.exec<{ at: number }>(`SELECT at FROM events WHERE kind = 'restore'`).one().at,
    );

    const [a, b] = await Promise.all([from.name, to].map((n) => inMemory(n, (obj, storage) => ({
      // Recall is compared below, after the tables: it writes to both.
      check: obj.check(),
      dump: dump(obj.store, storage).split("\n"),
      recall: ["纠正", "proxy 猫", "<tag>", "a&b"].map((q) => [false, true].map((deep) =>
        ok(obj.recall({ query: q, deep, sessionId: "" })).map((x) => `${x.id} ${x.state} ${x.tier} ${x.score}`))),
      tables: storage.sql.exec<{ c: number }>(`SELECT count(*) AS c FROM restores`).one().c,
    }))));
    if (a === undefined || b === undefined) expect.fail("two memories");
    expect(a.tables).toBe(0);
    expect(b.tables).toBe(1);
    // The check: the same figures and findings, but the restore.
    const events = Number(/(\d+) events/.exec(reportText(a.check))![1]);
    const expected = reportText(a.check)
      .replace(`${events} events`, `${events + 1} events`)
      .replace("0 restores", "1 restores")
      .replace(/\n$/, "\n  [restored] this memory was brought back from an export 1 time(s); what was lived between an export and its restore is not in it\n");
    expect(reportText(b.check)).toBe(expected.includes("notes: none") ? expected.replace("notes: none\n  ", "notes: \n  ") : expected);
    expect(b.check.findings.filter((f) => f.level === "problem")).toEqual([]);
    // The derived tables, apart from the restore row, and recall.
    const withoutRestore = b.dump.filter((l) => !l.startsWith(`[${restoreAt},`));
    expect(withoutRestore).toEqual(a.dump);
    expect(b.recall).toEqual(a.recall);
    expect(a.recall.flat(2).length).toBeGreaterThan(0);
  }, 60_000);
});

describe("settings", () => {
  const put = (name: string, b: unknown) => admin(`/admin/memories/${name}/settings`, { method: "PUT", body: JSON.stringify(b) });

  it("travel in the header, last and only when they differ from the defaults, and come back", async () => {
    const from = await createMemory();
    await inMemory(from.name, (obj) => generatedLife(obj, 120));
    expect((await put(from.name, { params: { baseStrength: 10, coreFeeling: 0.8 }, timeZone: "Asia/Shanghai" })).status).toBe(200);
    const file = await (await admin(`/admin/memories/${from.name}/export`)).text();
    const header = file.slice(0, file.indexOf("\n"));
    expect(header).toMatch(new RegExp(
      `^\\{"ziwo_export":1,"log_format":3,"instance":"i_[a-z2-9]{8}","exported_at":\\d+,` +
      `"settings":\\{"params":\\{"baseStrength":10,"recallBoost":2,"fadeBelow":0\\.3,"archiveBelow":0\\.05,` +
      `"coreImportance":0\\.9,"coreFeeling":0\\.8\\},"timezone":"Asia/Shanghai"\\}\\}$`,
    ));
    const to = freshName();
    expect((await importAs(to, file)).status).toBe(201);
    // Kept in the database, not only by the instance that imported them.
    await inMemory(to, (obj) => {
      (obj as unknown as { built?: unknown }).built = undefined;
    });
    expect(await body(await admin(`/admin/memories/${to}`))).toMatchObject({
      params: { ...defaultParams(), baseStrength: 10, coreFeeling: 0.8 }, timeZone: "Asia/Shanghai",
    });
    // The tables were built with them: the same as the original's, rebuilt
    // with them by the settings route.
    const [a, b] = await Promise.all([from.name, to].map((n) => inMemory(n, (obj, storage) => dump(obj.store, storage))));
    expect(b!.split("\n").filter((l) => !/^\[\d+,\d+,\d+\]$/.test(l))).toEqual(a!.split("\n").filter((l) => !/^\[\d+,\d+,\d+\]$/.test(l)));
    // The zone alone travels with the default parameters; back to the
    // defaults, the header is Go's again.
    expect((await put(from.name, { params: defaultParams() })).status).toBe(200);
    let again = await (await admin(`/admin/memories/${from.name}/export`)).text();
    expect(again.slice(0, again.indexOf("\n"))).toMatch(
      /,"settings":\{"params":\{"baseStrength":100,"recallBoost":2,"fadeBelow":0\.3,"archiveBelow":0\.05,"coreImportance":0\.9,"coreFeeling":0\.9\},"timezone":"Asia\/Shanghai"\}\}$/,
    );
    expect((await put(from.name, { timeZone: "UTC" })).status).toBe(200);
    again = await (await admin(`/admin/memories/${from.name}/export`)).text();
    expect(again.slice(0, again.indexOf("\n"))).toMatch(/^\{"ziwo_export":1,"log_format":3,"instance":"i_[a-z2-9]{8}","exported_at":\d+\}$/);
    // An export without settings is brought back with the defaults.
    const plain = freshName();
    expect((await importAs(plain, go.export)).status).toBe(201);
    expect(await body(await admin(`/admin/memories/${plain}`))).toMatchObject({ params: defaultParams(), timeZone: "UTC" });
  }, 60_000);

  it("in a header are checked as the settings route checks them; invalid ones refuse the import and leave nothing", async () => {
    const file = exportOf([{ seq: 1, at: t0, kind: "session", payload: `{"id":"s_aaaaaaaa"}` }]);
    const withSettings = (s: string) => file.replace(`"exported_at":${t0}}`, `"exported_at":${t0},"settings":${s}}`);
    const bad = "not a usable export: its settings are invalid: ";
    for (const [s, message] of [
      [`{"params":{"fadeBelow":0.01}}`, "need 0 < archive threshold < fade threshold < 1, got archive 0.05, fade 0.01"],
      [`{"params":{"baseStrength":"10"}}`, "parameter baseStrength must be a number"],
      [`{"params":{"strength":10}}`, `unknown parameter "strength": the parameters are baseStrength, recallBoost, fadeBelow, archiveBelow, coreImportance, coreFeeling`],
      [`{"timezone":"Mars/Base"}`, `unknown time zone "Mars/Base": give an IANA name such as Asia/Shanghai`],
      [`{"timezone":7}`, "timezone must be a string, an IANA name such as Asia/Shanghai"],
      [`{"timeZone":"UTC"}`, `unknown setting "timeZone": give params, timezone or both`],
      [`"UTC"`, "settings must be an object"],
    ] as const) {
      const name = freshName();
      const res = await importAs(name, withSettings(s));
      expect(res.status, s).toBe(400);
      expect(await res.json(), s).toEqual({ error: bad + message });
      expect(await tablesOf(name), s).toEqual([]);
    }
    // null is no settings; either part may be left out.
    for (const [s, params, zone] of [
      ["null", defaultParams(), "UTC"],
      [`{"timezone":"Europe/Paris"}`, defaultParams(), "Europe/Paris"],
      [`{"params":{"recallBoost":1}}`, { ...defaultParams(), recallBoost: 1 }, "UTC"],
    ] as const) {
      const name = freshName();
      expect((await importAs(name, withSettings(s))).status, s).toBe(201);
      expect(await body(await admin(`/admin/memories/${name}`)), s).toMatchObject({ params, timeZone: zone });
    }
  });
});

describe("the limit in bytes", () => {
  it("is 24 MiB, and an import that says it is larger is refused unread", async () => {
    expect(maxBytesInOneGo).toBe(24 * 1024 * 1024);
    const name = freshName();
    expect(await inMemory(name, (obj) => obj.byteLimit)).toBe(maxBytesInOneGo);
    const res = await fetchWorker(`/admin/memories/${name}/import`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminSecret}`, "content-length": String(maxBytesInOneGo + 1) },
      body: "x",
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "the export holds more than 25165824 bytes, more than this build can bring back in one go" });
    expect(await tablesOf(name)).toEqual([]);
  });

  it("is counted while an import is read, whatever the header says", async () => {
    const file = go.export;
    const size = new TextEncoder().encode(file).byteLength;
    const name = freshName();
    await inMemory(name, (obj) => {
      obj.byteLimit = size - 1;
    });
    // A stream has no content-length: the object counts.
    const stream = () => new Response(file).body!;
    const res = await fetchWorker(`/admin/memories/${name}/import`, {
      method: "POST", headers: { authorization: `Bearer ${adminSecret}` }, body: stream(),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: `the export holds more than ${size - 1} bytes, more than this build can bring back in one go` });
    expect(await tablesOf(name)).toEqual([]);
    await inMemory(name, (obj) => {
      obj.byteLimit = size;
    });
    expect((await importAs(name, file)).status).toBe(201);
  });

  it("refuses an export whose payloads and contents add up to more, before the file is built", async () => {
    const m = await createMemory();
    const bytes = await inMemory(m.name, (obj, storage) => {
      obj.store;
      loadRows(storage);
      // A payload with characters of more than one byte: bytes are counted.
      const wide = `{"id":"s_widechar","client":"客户端"}`;
      storage.sql.exec(`INSERT INTO events(at, kind, payload) VALUES(?, 'session', ?)`, t0, wide);
      let n = new TextEncoder().encode(wide).byteLength;
      for (const e of go.rows.events) n += new TextEncoder().encode(e[3]).byteLength;
      for (const c of go.rows.contents) n += new TextEncoder().encode(c[1]).byteLength;
      obj.byteLimit = n - 1;
      return n;
    });
    const res = await admin(`/admin/memories/${m.name}/export`);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: `this memory holds ${bytes} bytes of payloads and contents, more than this build can export in one go (at most ${bytes - 1})`,
    });
    await inMemory(m.name, (obj) => {
      obj.byteLimit = bytes;
    });
    expect((await admin(`/admin/memories/${m.name}/export`)).status).toBe(200);
  });
});

describe("the size limit", () => {
  // fillLog writes n session events straight into the log of a memory.
  async function fillLog(name: string, n: number): Promise<void> {
    await inMemory(name, (obj, storage) => {
      obj.store;
      storage.sql.exec(
        `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?)
         INSERT INTO events(at, kind, payload) SELECT ?, 'session', '{"id":"s_' || x || '"}' FROM c`,
        n, t0,
      );
    });
  }

  it("is 50,000 events for an export and a rebuild", async () => {
    expect(maxEventsInOneGo).toBe(50_000);
    const m = await createMemory();
    await fillLog(m.name, 50_000);
    const res = await admin(`/admin/memories/${m.name}/export`);
    expect(res.status).toBe(200);
    expect((await res.text()).split("\n").length).toBe(50_000 + 3);
    await fillLog(m.name, 1);
    for (const [path, method, what] of [["export", "GET", "export"], ["rebuild", "POST", "rebuild"]] as const) {
      const big = await admin(`/admin/memories/${m.name}/${path}`, { method });
      expect(big.status, path).toBe(413);
      expect(await big.json()).toEqual({
        error: `this memory holds 50001 events, more than this build can ${what} in one go (at most 50000)`,
      });
    }
    // New forgetting parameters replay the log too; a time zone does not.
    const settings = (b: string) => admin(`/admin/memories/${m.name}/settings`, { method: "PUT", body: b });
    const replay = await settings(`{"params":{"baseStrength":20},"timeZone":"Asia/Tokyo"}`);
    expect(replay.status).toBe(413);
    expect(await replay.json()).toEqual({
      error: "this memory holds 50001 events, more than this build can replay in one go (at most 50000)",
    });
    expect(await inMemory(m.name, (obj) => [obj.timeZone(), obj.params().baseStrength])).toEqual(["UTC", 100]);
    expect((await settings(`{"params":{"baseStrength":100},"timeZone":"Asia/Tokyo"}`)).status).toBe(200);
  }, 60_000);

  it("is 50,000 events for an import, refused before anything is stored", async () => {
    const events = Array.from({ length: 50_001 }, (_, i) => ({ seq: i + 1, at: t0, kind: "session", payload: `{"id":"s_${i}"}` }));
    const name = freshName();
    const res = await importAs(name, exportOf(events));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "the export holds more than 50000 events, more than this build can bring back in one go",
    });
    expect(await tablesOf(name)).toEqual([]);
    const fits = await importAs(name, exportOf(events.slice(0, 50_000)));
    expect(fits.status).toBe(201);
    expect(((await fits.json()) as { events: number }).events).toBe(50_000);
  }, 60_000);
});

it("the MCP surface is unchanged by an import: a memory brought back answers its tools", async () => {
  const name = freshName();
  const res = await importAs(name, exportOf([{ seq: 1, at: t0, kind: "session", payload: `{"id":"s_aaaaaaaa"}` }]));
  const token = ((await res.json()) as { token: string }).token;
  const c = new Client("old", { name, token });
  await c.connect();
  const s = idIn(await c.ok("get_context", {}), "s_");
  expect(await c.ok("remember", { session_id: s, gist: "after the import", body: "a body" })).toMatch(/^remembered as m_/);
});

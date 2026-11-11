// The admin page's files, driven without a browser: the texts of both
// languages, the logic the page and the script share, the instructions for
// each client, and that nothing refers to another origin.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { codexTomlOAuth, connectGuide, hookScript, hookSettings, mcpJson, mcpJsonOAuth } from "../../page/connect.mjs";
import { makeH } from "../../page/dom.mjs";
import {
  ApiError, defaultParams, errorText, makeApi, memoryHash, memoryPath, namesMatch, paramNames, pickLanguage, reportGroups, reportText, route,
  SecretError, sealedFileName, settingsChange, utcStamp,
} from "../../page/logic.mjs";
import { format, texts } from "../../page/texts.mjs";
import { repoRoot, workerDir } from "./go.mjs";

const pageDir = path.join(workerDir, "page");
const read = (/** @type {string} */ f) => readFile(path.join(pageDir, f), "utf8");
const placeholders = (/** @type {string} */ s) => [...s.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]).sort();

/** @param {"en" | "zh"} lang */
const words = (lang) => (/** @type {string} */ key, /** @type {Record<string, string>} */ vars) => {
  assert.ok(key in texts[lang], `no text ${key} in ${lang}`);
  return format(texts[lang][key], vars);
};

describe("the texts", () => {
  it("hold the same keys, with the same placeholders, in both languages, none empty", () => {
    assert.deepEqual(Object.keys(texts.zh).sort(), Object.keys(texts.en).sort());
    for (const k of Object.keys(texts.en)) {
      assert.deepEqual(placeholders(texts.zh[k]), placeholders(texts.en[k]), k);
      assert.notEqual(texts.en[k].trim(), "", k);
      assert.notEqual(texts.zh[k].trim(), "", k);
    }
  });

  it("are all used, and every text the page asks for is there", async () => {
    const code = (await read("app.mjs")) + (await read("connect.mjs"));
    const asked = new Set([...code.matchAll(/\bt\("([A-Za-z0-9-]+)"/g)].map((m) => m[1]));
    // Asked for by a name built at run time.
    for (const p of paramNames) asked.add(`param-${p}`);
    for (const c of ["short-passphrase", "not-export", "wrong-key", "gzip"]) asked.add(`seal-${c}`);
    for (const l of ["problem", "warning", "note"]) asked.add(`level-${l}`);
    asked.add("languageName"); // read straight from texts for the switch
    for (const k of asked) assert.ok(k in texts.en, `asked for, missing: ${k}`);
    for (const k of Object.keys(texts.en)) assert.ok(asked.has(k), `never asked for: ${k}`);
    assert.match(code, /t\(`param-\$\{p\}`\)/);
    assert.match(code, /t\(`seal-\$\{err\.code\}`/);
    assert.match(code, /`level-\$\{level\}`/);
  });

  it("give Go's words for sealing failures in English", () => {
    assert.equal(texts.en["seal-wrong-key"], "wrong passphrase, or the file was changed");
    assert.equal(texts.en["seal-not-export"], "not a ziwo export");
    assert.equal(format(texts.en["seal-short-passphrase"], { min: "12" }), "the passphrase must be at least 12 characters");
  });

  it("fill placeholders, and leave one without a value to show", () => {
    assert.equal(format("a {x} b {y}", { x: "1" }), "a 1 b {y}");
    assert.equal(format("{n}{n}", { n: 2 }), "22");
  });
});

describe("the admin API calls", () => {
  /** @param {(url: string, init: RequestInit) => Response} answer */
  function fake(answer) {
    /** @type {{ url: string, init: RequestInit }[]} */
    const calls = [];
    const doFetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
      calls.push({ url, init });
      return answer(url, init);
    };
    return { calls, api: makeApi({ base: "https://z.example", secret: "s3cret", fetch: /** @type {typeof fetch} */ (/** @type {unknown} */ (doFetch)) }) };
  }
  const ok = (/** @type {unknown} */ body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("go to the routes of the admin API, with the secret in the Authorization header only", async () => {
    const { calls, api } = fake(() => ok({ fine: true }));
    const bytes = new Uint8Array([1, 2, 3]);
    await api.list();
    await api.describe("a-1");
    await api.create("a-1");
    await api.newToken("a-1");
    await api.settings("a-1", { timeZone: "UTC" });
    await api.check("a-1");
    await api.rebuild("a-1");
    await api.importClear("a-1", bytes);
    await api.grants("a-1");
    await api.revokeGrant("a-1", "Ab_-0123456789xy");
    await api.deleteMemory("a-1", "a-1");
    await api.deleteMemory("a-1", "a 1/?&");
    const want = [
      ["GET", "/admin/memories"], ["GET", "/admin/memories/a-1"], ["POST", "/admin/memories/a-1"], ["POST", "/admin/memories/a-1/token"],
      ["PUT", "/admin/memories/a-1/settings"], ["GET", "/admin/memories/a-1/check"], ["POST", "/admin/memories/a-1/rebuild"],
      ["POST", "/admin/memories/a-1/import"], ["GET", "/admin/memories/a-1/grants"], ["DELETE", "/admin/memories/a-1/grants/Ab_-0123456789xy"],
      // The name repeated as typed, so that the API is what decides it matches.
      ["DELETE", "/admin/memories/a-1?confirm=a-1"], ["DELETE", "/admin/memories/a-1?confirm=a%201%2F%3F%26"],
    ];
    assert.deepEqual(calls.map((c) => [c.init.method, c.url]), want.map(([m, p]) => [m, `https://z.example${p}`]));
    for (const c of calls) {
      const h = /** @type {Record<string, string>} */ (c.init.headers);
      assert.equal(h.authorization, "Bearer s3cret");
      assert.equal(c.url.includes("s3cret"), false);
      assert.equal(String(c.init.body ?? "").includes("s3cret"), false);
    }
    assert.equal(calls[4].init.body, `{"timeZone":"UTC"}`);
    assert.equal(/** @type {Record<string, string>} */ (calls[4].init.headers)["content-type"], "application/json");
    assert.equal(calls[7].init.body, bytes);
    assert.equal(/** @type {Record<string, string>} */ (calls[7].init.headers)["content-type"], "application/x-ndjson");
    // check asks for JSON, not the text form.
    assert.equal(/** @type {Record<string, string>} */ (calls[5].init.headers).accept, "application/json");
  });

  it("fetch the export as bytes with its name", async () => {
    const { calls, api } = fake(() =>
      new Response(new Uint8Array([7, 8]), { headers: { "content-disposition": `attachment; filename="a-20261111-080000.ndjson"` } }));
    const got = await api.exportClear("a");
    assert.deepEqual(got, { bytes: new Uint8Array([7, 8]), disposition: `attachment; filename="a-20261111-080000.ndjson"` });
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].url, "https://z.example/admin/memories/a/export");
  });

  it("show the API's errors as they come", async () => {
    const cases = [
      [new Response(`{"error":"no such memory: \\"x\\""}\n`, { status: 404 }), 404, `no such memory: "x"`],
      [new Response("unauthorized\n", { status: 401 }), 401, "unauthorized"],
      [new Response("404 page not found\n", { status: 404 }), 404, "404 page not found"],
      [new Response(`{"other":1}`, { status: 500 }), 500, `{"other":1}`],
      [new Response("", { status: 503, statusText: "Service Unavailable" }), 503, "Service Unavailable"],
    ];
    for (const [res, status, text] of cases) {
      const { api } = fake(() => /** @type {Response} */ (res));
      await assert.rejects(api.describe("x"), (/** @type {unknown} */ err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, status);
        assert.equal(err.text, text);
        assert.equal(err.message, `HTTP ${status}: ${text}`);
        return true;
      });
    }
    assert.equal(await errorText(new Response(`{"error":"plain words"}`, { status: 400 })), "plain words");
  });

  it("refuse a secret that cannot go into a header, without saying it, and call nothing", async () => {
    for (const secret of ["", "  ", "line\nbreak", "密钥", "tab\there", "nul\0"]) {
      const calls = [];
      const api = makeApi({ secret, fetch: /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => calls.push(1))) });
      await assert.rejects(api.list(), (/** @type {unknown} */ err) => {
        assert.ok(err instanceof SecretError);
        if (secret.trim() !== "") assert.equal(/** @type {Error} */ (err).message.includes(secret), false);
        return true;
      });
      assert.equal(calls.length, 0);
    }
  });

  it("name memories in paths so that a name cannot leave its place", () => {
    assert.equal(memoryPath("a"), "/admin/memories/a");
    assert.equal(memoryPath("a", "check"), "/admin/memories/a/check");
    assert.equal(memoryPath("../x/y?z"), "/admin/memories/..%2Fx%2Fy%3Fz");
  });
});

describe("the page's decisions", () => {
  const current = { params: { ...defaultParams }, timeZone: "UTC" };
  const form = (/** @type {Record<string, string>} */ over = {}, zone = "UTC") => ({
    timeZone: zone,
    params: { ...Object.fromEntries(paramNames.map((p) => [p, String(/** @type {Record<string, number>} */ (defaultParams)[p])])), ...over },
  });

  it("send only the settings that changed, and say when that replays the memory", () => {
    assert.deepEqual(settingsChange(current, form()), { unchanged: true });
    assert.deepEqual(settingsChange(current, form({}, " Asia/Shanghai ")), { change: { timeZone: "Asia/Shanghai" }, replays: false });
    assert.deepEqual(settingsChange(current, form({ baseStrength: " 50 " })), { change: { params: { baseStrength: 50 } }, replays: true });
    assert.deepEqual(settingsChange(current, form({ fadeBelow: "0.30" })), { unchanged: true });
    assert.deepEqual(settingsChange(current, form({ coreFeeling: "0.8", recallBoost: "0" }, "Europe/Paris")), {
      change: { params: { recallBoost: 0, coreFeeling: 0.8 }, timeZone: "Europe/Paris" }, replays: true,
    });
    for (const bad of ["", "abc", "1,5", "Infinity", "NaN"]) assert.deepEqual(settingsChange(current, form({ archiveBelow: bad })), { notANumber: "archiveBelow" });
    // A value the store refuses is sent, for the store to say why.
    assert.deepEqual(settingsChange(current, form({ fadeBelow: "0.01" })), { change: { params: { fadeBelow: 0.01 } }, replays: true });
  });

  it("know the six parameters and their defaults as the Worker does", async () => {
    const decay = await readFile(path.join(workerDir, "src/store/decay.ts"), "utf8");
    const body = /export function defaultParams\(\): Params \{\s*return \{([^}]*)\}/.exec(decay)?.[1] ?? "";
    const fromWorker = Object.fromEntries([...body.matchAll(/(\w+): ([\d.]+),/g)].map((m) => [m[1], Number(m[2])]));
    assert.deepEqual(fromWorker, defaultParams);
    assert.deepEqual(Object.keys(fromWorker), paramNames);
  });

  it("name a sealed export as Go does", () => {
    assert.equal(sealedFileName(`attachment; filename="alice-20261111-080000.ndjson"`, "alice", 0), "alice-20261111-080000.ziwo-export");
    assert.equal(sealedFileName("", "bob", Date.UTC(2026, 10, 11, 8, 9, 10)), "bob-20261111-080910.ziwo-export");
    assert.equal(sealedFileName(`attachment; filename="../evil.ndjson"`, "c", Date.UTC(2026, 0, 2, 3, 4, 5)), "c-20260102-030405.ziwo-export");
  });

  it("lay the check out by level, and as the check tool's text", () => {
    const report = {
      figures: [{ name: "memories", value: "3" }, { name: "events", value: "7" }],
      findings: [
        { level: "note", code: "n1", text: "a note", ids: [] },
        { level: "problem", code: "p1", text: "2 broken", ids: ["m_aaaaaaaa", "m_bbbbbbbb"] },
        { level: "odd", code: "o1", text: "new level", ids: [] },
      ],
    };
    assert.deepEqual(reportGroups(report).map((g) => [g.level, g.findings.map((f) => f.code)]), [
      ["problem", ["p1"]], ["warning", []], ["note", ["n1"]], ["odd", ["o1"]],
    ]);
    assert.equal(reportText(report),
      "memories: 3\nevents: 7\nproblems: \n  [p1] 2 broken: m_aaaaaaaa, m_bbbbbbbb\nwarnings: none\nnotes: \n  [n1] a note\n");
  });

  it("route by the part after #, and never put more there than a name", () => {
    assert.deepEqual(route(""), { view: "list" });
    assert.deepEqual(route("#/"), { view: "list" });
    assert.deepEqual(route(memoryHash("a_b-1")), { view: "memory", name: "a_b-1" });
    assert.deepEqual(route(memoryHash("x/y")), { view: "memory", name: "x/y" });
    assert.deepEqual(route("#/memory/%E0%A4%A"), { view: "list" });
    assert.deepEqual(route("#/memory/a/b"), { view: "list" });
  });

  it("choose the language from the browser's, in its order", () => {
    assert.equal(pickLanguage(["zh-CN", "en"]), "zh");
    assert.equal(pickLanguage(["en-GB", "zh"]), "en");
    assert.equal(pickLanguage(["fr", "zh-Hans"]), "zh");
    assert.equal(pickLanguage(["fr", "de"]), "en");
    assert.equal(pickLanguage([]), "en");
    assert.equal(pickLanguage(["zhx"]), "en");
  });

  it("delete only when the name typed is the memory's", () => {
    assert.equal(namesMatch("alice", "alice"), true);
    assert.equal(namesMatch("  alice \n", "alice"), true);
    for (const typed of ["", "Alice", "alic", "alice2", "a lice", "bob"]) assert.equal(namesMatch(typed, "alice"), false, typed);
  });

  it("say, where it deletes, that an export is the only way back, and where it lists grants, that a new one can take seconds to show", () => {
    assert.match(texts.en.deleteNoWayBack, /only way back/);
    assert.match(texts.zh.deleteNoWayBack, /唯一的退路/);
    assert.match(texts.en.grantsLag, /some seconds/);
    assert.match(texts.zh.grantsLag, /几秒/);
  });

  it("write times as Go's list does", () => {
    assert.equal(utcStamp(Date.UTC(2026, 10, 11, 8, 5, 59)), "2026-11-11 08:05Z");
  });
});

describe("the instructions for each client", () => {
  const address = "https://ziwo.example/alice/mcp";
  const token = "ziwo_TESTTOKEN0000000000000000000000000000000";
  /** @typedef {ReturnType<typeof connectGuide>[number]} GuideClient */
  const steps = (/** @type {GuideClient} */ c) => [...c.oauth, ...c.token, ...c.either];
  const text = (/** @type {import("../../page/connect.mjs").Step[]} */ list) => list.flatMap((s) => [s.text, s.code ?? ""]).join("\n");
  const all = (/** @type {GuideClient[]} */ g) => g.map((c) => text(steps(c))).join("\n");

  for (const lang of /** @type {const} */ (["en", "zh"])) {
    it(`cover the five kinds of client, sign-in first and with the address, in ${lang}`, () => {
      const g = connectGuide(words(lang), { address, token });
      assert.deepEqual(g.map((c) => c.id), ["claude-code", "claude-apps", "chatgpt", "codex", "other"]);
      for (const c of g) {
        assert.ok(text(c.oauth).includes(address), c.id);
        assert.ok(c.oauth.some((s) => s.text === texts[lang].signInPage), `${c.id} says what the sign-in page asks`);
        assert.ok(c.token.length > 0, c.id);
        // Signing in needs no token: none is in any of its steps.
        assert.equal(text(c.oauth).includes(token), false, c.id);
        assert.equal(text(c.oauth).includes(texts[lang].tokenPlaceholder), false, c.id);
      }
      // ChatGPT on the web has sign-in alone.
      assert.equal(text(g[2].token).includes(token), false);
    });

    it(`put a token just issued where it is typed, and only a placeholder otherwise, in ${lang}`, () => {
      const g = connectGuide(words(lang), { address, token });
      const codes = (/** @type {string} */ id) => g.find((c) => c.id === id)?.token.map((s) => s.code ?? "").join("\n") ?? "";
      assert.ok(codes("claude-code").includes(`export ZIWO_TOKEN=${token}`));
      assert.ok(codes("claude-apps").includes(`Bearer ${token}`));
      assert.ok(codes("codex").includes(`export ZIWO_TOKEN=${token}`));
      assert.ok(codes("other").includes(`Authorization: Bearer ${token}`));
      // The configuration files read it from the environment.
      assert.equal(mcpJson(address).includes(token), false);
      const without = all(connectGuide(words(lang), { address }));
      assert.equal(without.includes("ziwo_"), false);
      assert.ok(without.includes(`export ZIWO_TOKEN=${texts[lang].tokenPlaceholder}`));
      assert.ok(without.includes(`Bearer ${texts[lang].tokenPlaceholder}`));
    });
  }

  it("give Claude Code and Codex, for sign-in, the same entries without a token", () => {
    const g = connectGuide(words("en"), { address, token });
    assert.deepEqual(JSON.parse(mcpJsonOAuth(address)), { mcpServers: { ziwo: { type: "http", alwaysLoad: true, url: address } } });
    const { headers: _h, ...entry } = JSON.parse(mcpJson(address)).mcpServers.ziwo;
    assert.deepEqual(JSON.parse(mcpJsonOAuth(address)).mcpServers.ziwo, entry);
    assert.equal(g[0].oauth[0].code, mcpJsonOAuth(address));
    assert.equal(g[0].oauth[1].code, "claude mcp login ziwo");
    assert.equal(codexTomlOAuth(address), `[mcp_servers.ziwo]\nurl = "${address}"\n`);
    assert.equal(g[3].oauth[0].code, codexTomlOAuth(address));
    assert.equal(g[3].oauth[1].code, "codex mcp login ziwo");
  });

  it("give Claude Code the entry, the hook and its settings that the Go build documents", async () => {
    const ex = path.join(repoRoot, "examples/claude-code");
    const example = JSON.parse(await readFile(path.join(ex, "mcp.json"), "utf8"));
    example.mcpServers.ziwo.url = address;
    assert.deepEqual(JSON.parse(mcpJson(address)), example);
    assert.equal(hookScript, await readFile(path.join(ex, "hooks/ziwo-session-start.sh"), "utf8"));
    assert.deepEqual(JSON.parse(hookSettings), JSON.parse(await readFile(path.join(ex, "settings.json"), "utf8")));
  });

  it("give the ChatGPT desktop app and Codex a configuration that reads the token from ZIWO_TOKEN", () => {
    const g = connectGuide(words("en"), { address, token });
    assert.equal(g[3].token[0].code, `[mcp_servers.ziwo]\nurl = "${address}"\nbearer_token_env_var = "ZIWO_TOKEN"\n`);
  });

  it("tell the Claude apps: sign in now, or no sign-in with the authorization header; then the preference line and the writing tools", () => {
    const g = connectGuide(words("en"), { address, token });
    for (const needle of ["Customize > Connectors", "Add custom connector", "Sign in now", "Use Claude's published identity", "Connect"]) {
      assert.ok(text(g[1].oauth).includes(needle), needle);
    }
    for (const needle of ["No sign-in", "authorization", `Bearer ${token}`]) assert.ok(text(g[1].token).includes(needle), needle);
    for (const needle of ["personal preferences", "get_context", "Always allow", "Remember a moment", "Reflect on what happened", "Amend a memory",
      "Erase a memory for good"]) {
      assert.ok(text(g[1].either).includes(needle), needle);
    }
  });

  it("name the writing tools by the titles the Worker gives them", async () => {
    const tools = await readFile(path.join(workerDir, "src/mcp/tools.ts"), "utf8");
    for (const [name, title] of [["remember", "Remember a moment"], ["reflect", "Reflect on what happened"], ["amend", "Amend a memory"], ["erase", "Erase a memory for good"]]) {
      assert.match(tools, new RegExp(`name: "${name}", title: "${title}"`));
    }
  });
});

describe("the page's elements", () => {
  // A stand-in document: elements as plain records.
  const doc = {
    createElement: (/** @type {string} */ tag) => {
      const el = {
        tag, attrs: /** @type {Record<string, string>} */ ({}), kids: /** @type {unknown[]} */ ([]), text: "", on: /** @type {string[]} */ ([]),
        setAttribute(/** @type {string} */ k, /** @type {string} */ v) { el.attrs[k] = v; },
        addEventListener(/** @type {string} */ type) { el.on.push(type); },
        append(/** @type {unknown} */ k) { el.kids.push(k); },
        set textContent(/** @type {string} */ v) { el.text = v; },
      };
      return el;
    },
  };
  const h = makeH(/** @type {Document} */ (/** @type {unknown} */ (doc)));

  it("flatten children to any depth, leave out nothing-values, and keep text as text", () => {
    const a = h("dt"), b = h("dd");
    const el = /** @type {any} */ (h("dl", {}, [[a, b], [null, [false, undefined]]], "<b>x</b>", 3, null));
    assert.deepEqual(el.kids, [a, b, "<b>x</b>", "3"]);
  });

  it("set attributes, text and listeners as asked", () => {
    const el = /** @type {any} */ (h("input", { id: "x", required: true, hidden: false, title: null, value: 0, text: "<i>", onclick: () => {} }));
    assert.deepEqual(el.attrs, { id: "x", required: "", value: "0" });
    assert.equal(el.text, "<i>");
    assert.deepEqual(el.on, ["click"]);
  });
});

describe("the page's files", () => {
  it("refer to nothing outside their origin", async () => {
    const files = await readdir(pageDir);
    assert.deepEqual(files.sort(), ["app.mjs", "connect.mjs", "dom.mjs", "index.html", "logic.mjs", "seal.mjs", "style.css", "texts.mjs"]);
    for (const f of files) {
      const s = await read(f);
      assert.equal(/\bhttps?:\/\/(?!ziwo\.example\.workers\.dev)/.test(s), false, `${f} names an address`);
      assert.equal(/["'(]\/\//.test(s), false, `${f} has a protocol-relative reference`);
      assert.equal(/@import|url\(/.test(s), false, `${f} loads something from CSS`);
      assert.equal(/\bimport\(/.test(s), false, `${f} imports at run time`);
      assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(s), false, `${f} parses markup or code`);
      assert.equal(/localStorage|sessionStorage|indexedDB|document\.cookie|console\./.test(s), false, `${f} keeps or logs something`);
      for (const m of s.matchAll(/^import [^;]*? from "([^"]+)";$/gms)) assert.match(m[1], /^\.\/[a-z]+\.mjs$/, `${f} imports ${m[1]}`);
    }
    const doc = await read("index.html");
    const named = [...doc.matchAll(/\b(?:src|href|action)="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(named.sort(), ["/_page/app.mjs", "/_page/style.css"]);
    assert.equal(/<script(?![^>]*\bsrc=)/.test(doc), false, "an inline script");
    assert.equal(/<style|\bstyle=/.test(doc), false, "an inline style");
  });

  it("call only the admin API, and only through logic.mjs", async () => {
    for (const f of ["app.mjs", "connect.mjs", "dom.mjs", "texts.mjs", "seal.mjs"]) assert.equal(/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/.test(await read(f)), false, f);
    const logic = await read("logic.mjs");
    assert.deepEqual([...logic.matchAll(/doFetch\(([^,]+),/g)].map((m) => m[1]), ["base + path"]);
    for (const m of logic.matchAll(/(?:call|send)\("[A-Z]+", ([^,)]+)/g)) assert.match(m[1], /^(?:"\/admin\/memories"|memoryPath\()/, m[1]);
  });

  it("are the only code of the Worker's that seals, and the Worker takes it as text only", async () => {
    const src = path.join(workerDir, "src");
    const found = [];
    for (const f of await readdir(src, { recursive: true })) {
      if (!/\.ts$/.test(f)) continue;
      const s = await readFile(path.join(src, f), "utf8");
      if (/page\/|seal/.test(s) && /from "\.\.\/page\//.test(s)) found.push(f);
      assert.equal(/deriveKey|deriveBits|PBKDF2|"AES-GCM"/.test(s), false, `${f} derives or seals`);
    }
    assert.deepEqual(found, ["page.ts"]);
    const wrangler = await readFile(path.join(workerDir, "wrangler.jsonc"), "utf8");
    assert.match(wrangler, /"type": "Text", "globs": \["\*\*\/page\/\*\.html", "\*\*\/page\/\*\.mjs", "\*\*\/page\/\*\.css"\]/);
  });
});

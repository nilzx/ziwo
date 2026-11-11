// bin/ziwo-admin.mjs, every command, against the Worker under wrangler dev,
// with the Go build on the other side of export and import. No output of
// the script may hold the admin secret, a token it did not just create, or
// what a memory says.

import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { open, seal } from "../../page/seal.mjs";
import { buildSealHelper, buildZiwo, goSeal, haveGo, removeScratch, scratch, workerDir } from "./go.mjs";
import { approveClient, startWorker, tool } from "./worker-dev.mjs";

const script = path.join(workerDir, "bin/ziwo-admin.mjs");
const marker = "clitestmarker";
const pass = "a passphrase for the test";
const magic = "ZIWO-EXPORT-1\n";
const tokenRE = /^token {4}(ziwo_[A-Za-z0-9_-]{43})$/m;
const go = haveGo();
const havePython = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;

// Runs a command in a terminal, types the passphrase in TYPED at each
// prompt, and prints all the terminal showed.
const ptyDriver = `
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    env = dict(os.environ)
    typed = env.pop("TYPED")
    os.execvpe(sys.argv[1], sys.argv[1:], env)
typed = os.environ["TYPED"].encode()
seen = b""
def until(pattern):
    global seen
    end = time.time() + 30
    while pattern not in seen:
        ready, _, _ = select.select([fd], [], [], max(0, end - time.time()))
        if not ready:
            sys.stdout.buffer.write(seen)
            sys.exit(90)
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            chunk = b""
        if not chunk:
            break
        seen += chunk
until(b"Passphrase: ")
os.write(fd, typed + b"\\r")
until(b"Passphrase again: ")
os.write(fd, typed + b"\\r")
until(b"Keep both.")
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(seen)
sys.exit(os.waitstatus_to_exitcode(status))
`;

/** @type {string} */ let dir;
/** @type {Awaited<ReturnType<typeof startWorker>>} */ let worker;
/** @type {string} */ let goBin = "";
/** @type {string} */ let sealBin = "";
// Everything the script printed, to look through at the end.
const printed = /** @type {string[]} */ ([]);
// Tokens that were issued, and so may be printed once, each by its own command.
const tokens = { a: "", b: "", delta: "", zeta1: "", zeta2: "" };

/**
 * cli runs the script with the deployment's address and secret in its
 * environment, from the scratch directory.
 * @param {string[]} args @param {Record<string, string | undefined>} [env]
 */
function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, ZIWO_URL: worker?.base, ZIWO_ADMIN_SECRET: worker?.secret, ...env },
  });
  printed.push(r.stdout, r.stderr);
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** @param {string[]} args @param {string} home */
function ziwo(args, home) {
  const r = spawnSync(goBin, args, { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, ZIWO_DIR: home, ZIWO_EXPORT_KEY: pass } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** @param {string} out */
function rowsOf(out) {
  return Object.fromEntries(out.trim().split("\n").map((l) => {
    const m = /^(\S+(?: \S+)?)\s{2,}(.*)$/.exec(l) ?? /^(\S+)\s+(.*)$/.exec(l);
    return [m?.[1] ?? l, m?.[2] ?? ""];
  }));
}

describe("ziwo-admin without a deployment", () => {
  it("prints its usage, and refuses an unknown command, as a usage error", () => {
    const none = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(none.status, 2);
    assert.match(none.stdout, /^ziwo-admin runs a ziwo deployment/);
    for (const cmd of ["list", "new", "token", "show", "set", "check", "rebuild", "export", "import", "grants", "revoke", "delete"]) {
      assert.match(none.stdout, new RegExp(`ziwo-admin ${cmd}\\b`));
    }
    assert.match(none.stdout, /an export is the only way back/);
    const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    const odd = spawnSync(process.execPath, [script, "destroy", "x"], { encoding: "utf8" });
    assert.equal(odd.status, 2);
    assert.match(odd.stderr, /^ziwo-admin: unknown command "destroy"/);
  });

  it("needs ZIWO_URL and ZIWO_ADMIN_SECRET, and https for another machine", () => {
    const run = (/** @type {Record<string, string>} */ env) =>
      spawnSync(process.execPath, [script, "list"], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
    let r = run({ ZIWO_ADMIN_SECRET: "s" });
    assert.equal(r.status, 2);
    assert.equal(r.stderr, "ziwo-admin list: set ZIWO_URL to the deployment's address, such as https://ziwo.example.workers.dev\n");
    r = run({ ZIWO_URL: "https://ziwo.example" });
    assert.equal(r.status, 2);
    assert.equal(r.stderr, "ziwo-admin list: set ZIWO_ADMIN_SECRET to the deployment's admin secret\n");
    for (const url of ["http://ziwo.example", "ftp://localhost", "not a url"]) {
      r = run({ ZIWO_URL: url, ZIWO_ADMIN_SECRET: "s" });
      assert.equal(r.status, 2, url);
    }
    r = run({ ZIWO_URL: "https://ziwo.example", ZIWO_ADMIN_SECRET: "two\u00e9" });
    assert.equal(r.status, 1);
    assert.equal(r.stderr, "ziwo-admin list: the admin secret holds a character that cannot be sent in a header\n");
  });
});

describe("ziwo-admin against a stand-in server", () => {
  it("exits 1 when the check finds a problem, as Go's check does, after printing the report", async () => {
    const report = {
      memory: "x",
      figures: [{ name: "memories", value: "1 standing" }],
      findings: [{ level: "problem", code: "broken", text: "1 broken thing", ids: ["m_aaaaaaaa"] }, { level: "note", code: "n", text: "a note", ids: [] }],
    };
    /** @type {string[]} */
    const seen = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization === "Bearer stand-in" ? "secret" : "no secret"}`);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(report));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
    const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
    const r = await new Promise((resolve) =>
      execFile(process.execPath, [script, "check", "x"], { env: { PATH: process.env.PATH, ZIWO_URL: `http://127.0.0.1:${port}/`, ZIWO_ADMIN_SECRET: "stand-in" } },
        (err, stdout, stderr) => resolve({ code: err === null ? 0 : err.code, stdout, stderr })));
    server.close();
    assert.deepEqual(seen, ["GET /admin/memories/x/check secret"]);
    assert.deepEqual(r, {
      code: 1,
      stdout: "memories: 1 standing\nproblems: \n  [broken] 1 broken thing: m_aaaaaaaa\nwarnings: none\nnotes: \n  [n] a note\n",
      stderr: `ziwo-admin check: 1 problem(s) found in "x"\n`,
    });
  });
});

describe("ziwo-admin against the Worker under wrangler dev", () => {
  before(async () => {
    dir = await scratch("ziwo-admin-");
    worker = await startWorker(dir);
    if (go) {
      goBin = buildZiwo(dir);
      sealBin = await buildSealHelper(dir);
    }
  });
  after(async () => {
    await worker?.stop();
    await removeScratch(dir);
  });

  it("is refused with the wrong secret, in the API's words", () => {
    const r = cli(["list"], { ZIWO_ADMIN_SECRET: "not-the-secret" });
    assert.equal(r.code, 1);
    assert.equal(r.err, "ziwo-admin list: HTTP 401: unauthorized\n");
  });

  it("lists nothing yet", () => {
    const r = cli(["list"]);
    assert.equal(r.code, 0);
    assert.equal(r.out, "no memories yet; create one with: ziwo-admin new <name>\n");
  });

  it("creates a memory and prints its token once, and shows the API's refusals as they come", () => {
    const r = cli(["new", "alpha"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^created alpha\naddress {2}http:\/\/127\.0\.0\.1:\d+\/alpha\/mcp\ntoken {4}ziwo_/);
    assert.match(r.out, /The token is shown this once\. Only its hash is stored\.\nIt cannot be shown again/);
    tokens.a = tokenRE.exec(r.out)?.[1] ?? "";
    assert.notEqual(tokens.a, "");
    let e = cli(["new", "alpha"]);
    assert.equal(e.code, 1);
    assert.equal(e.err, `ziwo-admin new: HTTP 409: memory "alpha" already exists\n`);
    e = cli(["new", "Bad"]);
    assert.equal(e.code, 1);
    assert.equal(e.err, `ziwo-admin new: HTTP 400: invalid memory name "Bad": use 1 to 32 lower-case letters, digits, - or _, starting with a letter or digit\n`);
    e = cli(["new"]);
    assert.equal(e.code, 2);
  });

  it("lists and shows a memory by its figures, never by what it says", async () => {
    const c = await tool(worker.base, "alpha", tokens.a, "get_context", {});
    const session = /s_[a-z2-9]{8}/.exec(c.text)?.[0] ?? "";
    assert.notEqual(session, "");
    for (const n of [1, 2, 3]) {
      const w = await tool(worker.base, "alpha", tokens.a, "remember", { session_id: session, gist: `${marker} gist ${n}`, body: `${marker} body` });
      assert.match(w.text, /m_[a-z2-9]{8}/);
    }
    const l = cli(["list"]);
    assert.equal(l.code, 0);
    const [head, row] = l.out.trim().split("\n");
    assert.match(head ?? "", /^NAME\s+MEMORIES\s+EVENTS\s+LAST EVENT\s+TOKEN\s+CREATED$/);
    assert.match(row ?? "", /^alpha\s+3\s+\d+\s+\d{4}-\d\d-\d\d \d\d:\d\dZ\s+set\s+\d{4}-\d\d-\d\d \d\d:\d\dZ$/);
    const s = cli(["show", "alpha"]);
    assert.equal(s.code, 0);
    const rows = rowsOf(s.out);
    assert.equal(rows.memory, "alpha");
    assert.equal(rows.address, `${worker.base}/alpha/mcp`);
    assert.equal(rows.memories, "3");
    assert.equal(rows.token, "set");
    assert.equal(rows.timeZone, "UTC");
    assert.deepEqual([rows.baseStrength, rows.recallBoost, rows.fadeBelow, rows.archiveBelow, rows.coreImportance, rows.coreFeeling],
      ["100", "2", "0.3", "0.05", "0.9", "0.9"]);
    const e = cli(["show", "ghost"]);
    assert.equal(e.code, 1);
    assert.equal(e.err, `ziwo-admin show: HTTP 404: no such memory: "ghost"\n`);
  });

  it("changes settings, says when that replays the memory, and passes the store's refusals on", () => {
    let r = cli(["set", "alpha", "timeZone=Asia/Shanghai"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(rowsOf(r.out).timeZone, "Asia/Shanghai");
    assert.equal(r.out.includes("replayed"), false);
    r = cli(["set", "alpha", "baseStrength=50", "recallBoost=1"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(rowsOf(r.out).baseStrength, "50");
    assert.match(r.out, /The memory was replayed with these values\.\n$/);
    assert.equal(rowsOf(cli(["show", "alpha"]).out).recallBoost, "1");
    r = cli(["set", "alpha", "fadeBelow=0.01"]);
    assert.equal(r.code, 1);
    assert.equal(r.err, "ziwo-admin set: HTTP 400: need 0 < archive threshold < fade threshold < 1, got archive 0.05, fade 0.01\n");
    r = cli(["set", "alpha", "timeZone=Mars/Base"]);
    assert.equal(r.err, `ziwo-admin set: HTTP 400: unknown time zone "Mars/Base": give an IANA name such as Asia/Shanghai\n`);
    for (const bad of [["bogus=1"], ["baseStrength=abc"], ["baseStrength="], ["=1"], ["nothing"], []]) {
      r = cli(["set", "alpha", ...bad]);
      assert.equal(r.code, 2, bad.join(" "));
    }
    assert.equal(rowsOf(cli(["show", "alpha"]).out).baseStrength, "50");
  });

  it("checks, as the check tool words it", async () => {
    const r = cli(["check", "alpha"]);
    assert.equal(r.code, 0, r.err);
    const text = await (await fetch(`${worker.base}/admin/memories/alpha/check`, {
      headers: { authorization: `Bearer ${worker.secret}`, accept: "text/plain" },
    })).text();
    assert.equal(r.out, text);
    assert.match(r.out, /^problems: none$/m);
  });

  it("rebuilds", () => {
    const r = cli(["rebuild", "alpha"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^rebuilt 3 memories from \d+ events\n$/);
  });

  it("replaces a token: the old one stops working, the new one works", async () => {
    const r = cli(["token", "alpha"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^new token for alpha\n/);
    assert.match(r.out, /The old token no longer works\. The new one is shown this once\./);
    tokens.b = tokenRE.exec(r.out)?.[1] ?? "";
    assert.notEqual(tokens.b, "");
    assert.notEqual(tokens.b, tokens.a);
    assert.equal((await tool(worker.base, "alpha", tokens.a, "check", {})).status, 401);
    assert.equal((await tool(worker.base, "alpha", tokens.b, "check", {})).status, 200);
  });

  it("exports only sealed, never over a file, readable by its owner alone", async () => {
    let r = cli(["export", "alpha", "-o", "short.ziwo-export"], { ZIWO_PASSPHRASE: "elevenchars" });
    assert.equal(r.code, 1);
    assert.equal(r.err, "ziwo-admin export: the passphrase must be at least 12 characters\n");
    await assert.rejects(stat(path.join(dir, "short.ziwo-export")));
    // No passphrase and no terminal to ask in.
    r = cli(["export", "alpha", "-o", "none.ziwo-export"]);
    assert.equal(r.code, 2);
    assert.equal(r.err, "ziwo-admin export: set ZIWO_PASSPHRASE, or run in a terminal to be asked for the passphrase\n");
    r = cli(["export", "alpha", "-o", "alpha.ziwo-export"], { ZIWO_PASSPHRASE: pass });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^exported "alpha" to alpha\.ziwo-export \(\d+ bytes, sealed\)\nIt opens only with its passphrase\. Keep both\.\n$/);
    const file = path.join(dir, "alpha.ziwo-export");
    const box = await readFile(file);
    assert.equal(box.subarray(0, magic.length).toString(), magic);
    assert.equal(box.includes(marker), false);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.match(new TextDecoder().decode(await open(box, pass)), new RegExp(marker));
    r = cli(["export", "alpha", "-o", "alpha.ziwo-export"], { ZIWO_PASSPHRASE: pass });
    assert.equal(r.code, 1);
    assert.equal(r.err, "ziwo-admin export: alpha.ziwo-export already exists\n");
    // Named as Go names an export, by default.
    r = cli(["export", "alpha"], { ZIWO_PASSPHRASE: pass });
    assert.equal(r.code, 0, r.err);
    const named = /to (alpha-\d{8}-\d{6}\.ziwo-export) /.exec(r.out)?.[1] ?? "";
    assert.notEqual(named, "");
    assert.match(new TextDecoder().decode(await open(await readFile(path.join(dir, named)), pass)), new RegExp(marker));
    r = cli(["export", "ghost", "-o", "ghost.ziwo-export"], { ZIWO_PASSPHRASE: pass });
    assert.equal(r.code, 1);
    assert.equal(r.err, `ziwo-admin export: HTTP 404: no such memory: "ghost"\n`);
    await assert.rejects(stat(path.join(dir, "ghost.ziwo-export")));
  });

  it("asks for the passphrase twice in a terminal, without echo", { skip: havePython ? false : "no python3 for a terminal" }, async () => {
    const r = spawnSync("python3", ["-I", "-c", ptyDriver, process.execPath, script, "export", "alpha", "-o", "typed.ziwo-export"], {
      cwd: dir, encoding: "utf8", timeout: 60_000,
      env: { PATH: process.env.PATH, ZIWO_URL: worker.base, ZIWO_ADMIN_SECRET: worker.secret, TERM: "dumb", TYPED: pass },
    });
    printed.push(r.stdout);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /Passphrase: [\s\S]*Passphrase again: [\s\S]*exported "alpha" to typed\.ziwo-export/);
    assert.equal(r.stdout.includes(pass), false, "the passphrase was echoed");
    const typed = await open(await readFile(path.join(dir, "typed.ziwo-export")), pass);
    assert.match(new TextDecoder().decode(typed), new RegExp(marker));
  });

  it("writes an export the Go build opens and imports", { skip: go ? false : "no go command" }, () => {
    const home = path.join(dir, "go-home");
    spawnSync("mkdir", [home]);
    const r = ziwo(["import", "gocopy", path.join(dir, "alpha.ziwo-export")], home);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^brought back 3 memories from \d+ events, as exported on /);
    assert.match(r.out, /It answers to the token it had when it was exported\./);
    const l = ziwo(["list"], home);
    assert.match(l.out, /^gocopy\s+3\s+\d+\s+\S+ \S+\s+set$/m);
  });

  it("imports what the Go build exported, which keeps its token", { skip: go ? false : "no go command" }, async () => {
    const home = path.join(dir, "go-home");
    const out = path.join(dir, "from-go.ziwo-export");
    const e = ziwo(["export", "gocopy", "-o", out], home);
    assert.equal(e.code, 0, e.err);
    const r = cli(["import", "beta", out], { ZIWO_PASSPHRASE: pass });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^brought back 3 memories from \d+ events, as exported on \d{4}-\d\d-\d\d \d\d:\d\dZ\naddress {2}http:\/\/127\.0\.0\.1:\d+\/beta\/mcp\nIt answers to the token it had when it was exported\.\n$/);
    assert.equal((await tool(worker.base, "beta", tokens.b, "check", {})).status, 200);
    assert.equal(rowsOf(cli(["show", "beta"]).out).memories, "3");
  });

  it("imports an export that held no token, and prints the new token once", { skip: go ? false : "no go command" }, async () => {
    const clear = new TextDecoder().decode(await open(await readFile(path.join(dir, "alpha.ziwo-export")), pass));
    const without = clear.replace(/,"token_sha256":"[0-9a-f]+"/, "");
    assert.notEqual(without, clear);
    const sealed = goSeal(sealBin, "seal", new TextEncoder().encode(without), pass);
    assert.ok(sealed.ok);
    await writeFile(path.join(dir, "no-token.ziwo-export"), sealed.out);
    const r = cli(["import", "delta", "no-token.ziwo-export"], { ZIWO_PASSPHRASE: pass });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /The export held no token\. This one is shown this once\. Only its hash is stored\./);
    tokens.delta = tokenRE.exec(r.out)?.[1] ?? "";
    assert.notEqual(tokens.delta, "");
    assert.equal((await tool(worker.base, "delta", tokens.delta, "check", {})).status, 200);
    assert.equal((await tool(worker.base, "delta", tokens.b, "check", {})).status, 401);
  });

  it("refuses to import with a wrong passphrase, a file that is not an export, or a name in use", async () => {
    await writeFile(path.join(dir, "not-export.txt"), "SQLite format 3\0");
    const cases = [
      [["import", "gamma", "alpha.ziwo-export"], { ZIWO_PASSPHRASE: `${pass}x` }, "ziwo-admin import: wrong passphrase, or the file was changed\n"],
      [["import", "gamma", "not-export.txt"], { ZIWO_PASSPHRASE: pass }, "ziwo-admin import: not a ziwo export\n"],
      [["import", "alpha", "alpha.ziwo-export"], { ZIWO_PASSPHRASE: pass }, `ziwo-admin import: HTTP 409: memory "alpha" already exists\n`],
    ];
    for (const [args, env, want] of cases) {
      const r = cli(/** @type {string[]} */ (args), /** @type {Record<string, string>} */ (env));
      assert.equal(r.code, 1);
      assert.equal(r.err, want);
    }
    const bad = Buffer.from(await readFile(path.join(dir, "alpha.ziwo-export")));
    bad[bad.length - 5] ^= 1;
    await writeFile(path.join(dir, "changed.ziwo-export"), bad);
    const r = cli(["import", "gamma", "changed.ziwo-export"], { ZIWO_PASSPHRASE: pass });
    assert.equal(r.err, "ziwo-admin import: wrong passphrase, or the file was changed\n");
    assert.equal(cli(["import", "gamma"]).code, 2);
    assert.equal(/^gamma\b/m.test(cli(["list"]).out), false);
  });

  it("a sealed file made here is what an import takes", async () => {
    // Round trip through the script alone, for a deployment without Go.
    const clear = await open(await readFile(path.join(dir, "alpha.ziwo-export")), pass);
    await writeFile(path.join(dir, "resealed.ziwo-export"), await seal(clear, pass));
    const r = cli(["import", "epsilon", "resealed.ziwo-export"], { ZIWO_PASSPHRASE: pass });
    assert.equal(r.code, 0, r.err);
    assert.equal(rowsOf(cli(["show", "epsilon"]).out).memories, "3");
  });

  it("lists the clients signed in to a memory, and revokes one by its id", async () => {
    let r = cli(["grants", "alpha"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "no client has signed in to alpha; one approved a moment ago can take some seconds to show up\n");
    await approveClient(worker.base, "alpha", tokens.b, "cli test client");
    r = cli(["grants", "alpha"]);
    assert.equal(r.code, 0, r.err);
    const [head, row, more] = r.out.trim().split("\n");
    assert.match(head ?? "", /^ID\s+APPROVED\s+LAPSES UNLESS USED\s+CLIENT$/);
    const m = /^([A-Za-z0-9_-]{16})\s+\d{4}-\d\d-\d\d \d\d:\d\dZ\s+not yet used\s+cli test client$/.exec(row ?? "");
    assert.ok(m, row);
    assert.equal(more, undefined);
    const id = m[1];
    r = cli(["revoke", "alpha", id]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`^revoked ${id} from alpha\n`));
    r = cli(["revoke", "alpha", id]);
    assert.equal(r.code, 1);
    assert.equal(r.err, `ziwo-admin revoke: HTTP 404: no such grant: "${id}"\n`);
    assert.match(cli(["grants", "alpha"]).out, /^no client has signed in to alpha/);
    assert.equal(cli(["revoke", "alpha"]).code, 2);
    assert.equal(cli(["grants"]).code, 2);
    r = cli(["grants", "ghost"]);
    assert.equal(r.code, 1);
    assert.equal(r.err, `ziwo-admin grants: HTTP 404: no such memory: "ghost"\n`);
  });

  it("deletes a memory only when its name is given twice, and the name can be used again", async () => {
    let r = cli(["new", "zeta"]);
    assert.equal(r.code, 0, r.err);
    tokens.zeta1 = tokenRE.exec(r.out)?.[1] ?? "";
    assert.equal((await tool(worker.base, "zeta", tokens.zeta1, "check", {})).status, 200);
    for (const args of [["delete", "zeta"], ["delete", "zeta", "zet"], ["delete", "zeta", "Zeta"], ["delete"]]) {
      r = cli(args);
      assert.equal(r.code, 2, args.join(" "));
    }
    assert.equal(cli(["delete", "zeta", "zetax"]).err, "ziwo-admin delete: the two names differ: give the name of the memory twice, to confirm\n");
    assert.equal((await tool(worker.base, "zeta", tokens.zeta1, "check", {})).status, 200);
    r = cli(["delete", "zeta", "zeta"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "deleted zeta: 0 signed-in client(s) revoked; the name is free\n");
    assert.equal((await tool(worker.base, "zeta", tokens.zeta1, "check", {})).status, 401);
    assert.equal(cli(["show", "zeta"]).err, `ziwo-admin show: HTTP 404: no such memory: "zeta"\n`);
    assert.equal(/^zeta\b/m.test(cli(["list"]).out), false);
    r = cli(["delete", "zeta", "zeta"]);
    assert.equal(r.code, 1);
    assert.equal(r.err, `ziwo-admin delete: HTTP 404: no such memory: "zeta"\n`);
    r = cli(["new", "zeta"]);
    assert.equal(r.code, 0, r.err);
    tokens.zeta2 = tokenRE.exec(r.out)?.[1] ?? "";
    assert.equal(rowsOf(cli(["show", "zeta"]).out).memories, "0");
    assert.equal((await tool(worker.base, "zeta", tokens.zeta1, "check", {})).status, 401);
    assert.equal((await tool(worker.base, "zeta", tokens.zeta2, "check", {})).status, 200);
  });

  it("never printed the secret, a token it did not just create, or what a memory says", () => {
    const all = printed.join("\n");
    assert.equal(all.includes(worker.secret), false);
    assert.equal(all.includes(marker), false);
    assert.equal(all.includes(pass), false);
    // Each token appears where it was issued, once.
    for (const t of [tokens.a, tokens.b, tokens.delta, tokens.zeta1, tokens.zeta2]) {
      if (t === "") continue;
      assert.equal(all.split(t).length - 1, 1, "a token was printed more than once");
    }
  });

  // Last: it holds this machine's address for a minute.
  it("is held after ten wrong secrets in a minute, in the API's words, and the right one is held too", () => {
    // One wrong secret was spent at the start.
    for (let i = 0; i < 9; i++) assert.equal(cli(["list"], { ZIWO_ADMIN_SECRET: `wrong-${i}` }).err, "ziwo-admin list: HTTP 401: unauthorized\n");
    for (const secret of ["wrong-again", worker.secret]) {
      const r = cli(["list"], { ZIWO_ADMIN_SECRET: secret });
      assert.equal(r.code, 1);
      assert.match(r.err, /^ziwo-admin list: HTTP 429: too many wrong attempts from this address; try again in \d+ seconds\n$/);
    }
  });
});

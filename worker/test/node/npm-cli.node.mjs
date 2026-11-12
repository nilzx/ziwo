// The npm package's `ziwo` command (npm/lib/cli.mjs, npm/bin/ziwo.mjs): its
// arguments, its messages in both languages, the Node.js version check, and
// how it runs wrangler, first with a stand-in for spawn, then as a process
// with a stand-in wrangler installed beside it. Nothing here runs wrangler.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { address, help, language, minNode, olderThan, parse, run, texts } from "../../npm/lib/cli.mjs";
import { removeScratch, scratch, workerDir } from "./go.mjs";

const pkgDir = path.join("/somewhere", "node_modules", "ziwo");
const wranglerBin = path.join("/somewhere", "node_modules", "wrangler", "bin", "wrangler.js");

/**
 * fake makes an io for run with a stand-in spawn that ends the way `end`
 * says, and records what happened.
 * @param {{ argv: string[], env?: Record<string, string>, nodeVersion?: string, end?: { code?: number | null, signal?: string | null, error?: boolean, throws?: boolean }, written?: string, intl?: string }} o
 */
function fake(o) {
  const seen = {
    out: "", err: "", removed: /** @type {string[]} */ ([]), read: /** @type {string[]} */ ([]),
    spawned: /** @type {{ command: string, args: string[], options: { cwd: string, env: Record<string, string | undefined>, stdio: string } }[]} */ ([]),
  };
  const end = o.end ?? { code: 0 };
  /** @type {import("../../npm/lib/cli.mjs").Io} */
  const io = {
    argv: o.argv,
    env: o.env ?? { PATH: "/bin", LANG: "en_US.UTF-8" },
    nodeVersion: o.nodeVersion ?? "24.1.0",
    execPath: "/usr/local/bin/node",
    packageDir: pkgDir,
    version: "0.1.0",
    nodeRange: ">=22.12.0",
    wrangler: () => wranglerBin,
    spawn: (command, args, options) => {
      seen.spawned.push({ command, args, options });
      if (end.throws) throw new Error("spawn failed");
      const child = new EventEmitter();
      setImmediate(() => {
        if (end.error) child.emit("error", new Error("ENOENT"));
        else child.emit("exit", end.code ?? null, end.signal ?? null);
      });
      return child;
    },
    out: (t) => {
      seen.out += t;
    },
    err: (t) => {
      seen.err += t;
    },
    readFile: (f) => {
      seen.read.push(f);
      return o.written;
    },
    removeFile: (f) => {
      seen.removed.push(f);
    },
    intlLocale: () => o.intl ?? "en-US",
    token: () => "abc123",
  };
  return { io, seen };
}

const deployLine = (/** @type {string[]} */ targets) =>
  `${JSON.stringify({ type: "wrangler-session", version: 1 })}\n${JSON.stringify({ type: "deploy", version: 1, worker_name: "ziwo", targets })}\n`;

describe("the command line", () => {
  it("is read into a command", () => {
    assert.deepEqual(parse([]), { kind: "help" });
    assert.deepEqual(parse(["--help"]), { kind: "help" });
    assert.deepEqual(parse(["-h"]), { kind: "help" });
    assert.deepEqual(parse(["help"]), { kind: "help" });
    assert.deepEqual(parse(["deploy", "--help"]), { kind: "help" });
    assert.deepEqual(parse(["--version"]), { kind: "version" });
    assert.deepEqual(parse(["-v"]), { kind: "version" });
    assert.deepEqual(parse(["deploy"]), { kind: "deploy", dryRun: false });
    assert.deepEqual(parse(["deploy", "--dry-run"]), { kind: "deploy", dryRun: true });
    assert.deepEqual(parse(["deploy", "--name", "mine", "--dry-run"]), { kind: "deploy", name: "mine", dryRun: true });
    assert.deepEqual(parse(["deploy", "--dry-run", "--name=mine"]), { kind: "deploy", name: "mine", dryRun: true });
    assert.deepEqual(parse(["deploy", "--name"]), { kind: "error", text: "noName", arg: "--name" });
    assert.deepEqual(parse(["deploy", "--name", "--dry-run"]), { kind: "error", text: "noName", arg: "--name" });
    assert.deepEqual(parse(["deploy", "--name="]), { kind: "error", text: "noName", arg: "--name=" });
    assert.deepEqual(parse(["deploy", "--force"]), { kind: "error", text: "unknown", arg: "--force" });
    assert.deepEqual(parse(["update"]), { kind: "error", text: "unknown", arg: "update" });
    assert.deepEqual(parse(["--version", "deploy"]), { kind: "error", text: "unknown", arg: "--version" });
  });

  it("prints the help alone, with --help, and on --help after deploy, and runs nothing", async () => {
    assert.equal(help.split("\n")[0], "ziwo: a memory of its own for your AI assistant, in your Cloudflare account.");
    assert.match(help, /^ {2}npx ziwo@latest deploy {14}deploy, or update, ziwo$/m);
    assert.match(help, /^ {6}--name <name> {19}deploy under another Worker name \(default: ziwo\)$/m);
    assert.match(help, /^ {6}--dry-run {23}build and check, deploy nothing$/m);
    assert.match(help, /^ {2}npx ziwo@latest --version$/m);
    assert.match(help, /\n\nhttps:\/\/github\.com\/nilzx\/ziwo\n$/);
    for (const argv of [[], ["--help"], ["-h"], ["deploy", "--help"]]) {
      const { io, seen } = fake({ argv });
      assert.equal(await run(io), 0);
      assert.equal(seen.out, help);
      assert.equal(seen.err, "");
      assert.equal(seen.spawned.length, 0);
    }
  });

  it("prints the version", async () => {
    const { io, seen } = fake({ argv: ["--version"] });
    assert.equal(await run(io), 0);
    assert.equal(seen.out, "0.1.0\n");
    assert.equal(seen.spawned.length, 0);
  });

  it("refuses what it does not know, in the person's language, with the help, and exits 2", async () => {
    let f = fake({ argv: ["deploy", "--force"] });
    assert.equal(await run(f.io), 2);
    assert.equal(f.seen.err, `ziwo does not know "--force".\n\n${help}`);
    assert.equal(f.seen.out, "");
    assert.equal(f.seen.spawned.length, 0);
    f = fake({ argv: ["deploy", "--name"], env: { LANG: "zh_CN.UTF-8" } });
    assert.equal(await run(f.io), 2);
    assert.equal(f.seen.err, `--name 后面要跟一个 Worker 名称。\n\n${help}`);
    f = fake({ argv: ["update"], env: { LANG: "zh_CN.UTF-8" } });
    assert.equal(await run(f.io), 2);
    assert.equal(f.seen.err, `ziwo 不认识"update"。\n\n${help}`);
  });
});

describe("the language", () => {
  const intl = (/** @type {string} */ l) => () => l;
  it("follows LC_ALL, then LC_MESSAGES, then LANG, then Intl", () => {
    assert.equal(language({ LANG: "zh_CN.UTF-8" }, intl("en-US")), "zh");
    assert.equal(language({ LANG: "en_US.UTF-8" }, intl("zh-CN")), "en");
    assert.equal(language({ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" }, intl("zh-CN")), "en");
    assert.equal(language({ LC_ALL: "zh_TW.UTF-8", LANG: "en_US.UTF-8" }, intl("en-US")), "zh");
    assert.equal(language({ LC_MESSAGES: "zh_CN", LANG: "en_US.UTF-8" }, intl("en-US")), "zh");
    assert.equal(language({ LC_ALL: "", LC_MESSAGES: "", LANG: "zh_CN.GB18030" }, intl("en-US")), "zh");
    assert.equal(language({}, intl("zh-CN")), "zh");
    assert.equal(language({}, intl("zh-Hans-CN")), "zh");
    assert.equal(language({}, intl("en-GB")), "en");
    assert.equal(language({}, () => { throw new Error("no Intl"); }), "en");
  });

  it("passes over C and POSIX, which name no language", () => {
    assert.equal(language({ LC_ALL: "C", LANG: "zh_CN.UTF-8" }, intl("en-US")), "zh");
    assert.equal(language({ LC_ALL: "C.UTF-8" }, intl("zh-CN")), "zh");
    assert.equal(language({ LANG: "POSIX" }, intl("en-US")), "en");
  });

  it("does not take another language for Chinese", () => {
    assert.equal(language({ LANG: "zu_ZA.UTF-8" }, intl("zh-CN")), "en");
    assert.equal(language({}, intl("zza")), "en");
  });

  it("has every message in both", () => {
    assert.deepEqual(Object.keys(texts.zh).sort(), Object.keys(texts.en).sort());
  });
});

describe("the Node.js version check", () => {
  it("reads the lowest version from wrangler's engines", () => {
    assert.equal(minNode(">=22.12.0"), "22.12.0");
    assert.equal(minNode(" >= v20.0.1 "), "20.0.1");
    assert.equal(minNode("^22 || >=24"), undefined);
    assert.equal(minNode(undefined), undefined);
  });

  it("compares versions by number", () => {
    assert.equal(olderThan("18.19.0", "22.12.0"), true);
    assert.equal(olderThan("22.11.9", "22.12.0"), true);
    assert.equal(olderThan("22.9.0", "22.12.0"), true);
    assert.equal(olderThan("22.12.0", "22.12.0"), false);
    assert.equal(olderThan("22.13.0", "22.12.0"), false);
    assert.equal(olderThan("100.0.0", "22.12.0"), false);
    assert.equal(olderThan("v23.0.0-pre", "22.12.0"), false);
  });

  it("stops before wrangler when Node.js is too old, saying so in one sentence", async () => {
    let f = fake({ argv: ["deploy"], nodeVersion: "18.19.0" });
    assert.equal(await run(f.io), 1);
    assert.equal(f.seen.err, "ziwo needs Node.js 22.12.0 or later; this is 18.19.0. Get the current version from https://nodejs.org and run the command again.\n");
    assert.equal(f.seen.spawned.length, 0);
    f = fake({ argv: ["deploy", "--dry-run"], nodeVersion: "20.5.1", env: { LANG: "zh_CN.UTF-8" } });
    assert.equal(await run(f.io), 1);
    assert.equal(f.seen.err, "ziwo 需要 Node.js 22.12.0 或更高版本,当前是 20.5.1。请到 https://nodejs.org 安装最新版本,然后再运行一次。\n");
    assert.equal(f.seen.spawned.length, 0);
  });

  it("lets the lowest version through", async () => {
    const f = fake({ argv: ["deploy"], nodeVersion: "22.12.0" });
    assert.equal(await run(f.io), 0);
    assert.equal(f.seen.spawned.length, 1);
  });
});

describe("ziwo deploy", () => {
  it("runs the package's wrangler with the running node and the packaged configuration, in the package, on the terminal", async () => {
    const f = fake({ argv: ["deploy"] });
    assert.equal(await run(f.io), 0);
    assert.equal(f.seen.spawned.length, 1);
    const [s] = f.seen.spawned;
    assert.equal(s.command, "/usr/local/bin/node");
    assert.deepEqual(s.args, [wranglerBin, "deploy", "--config", path.join(pkgDir, "wrangler.jsonc")]);
    assert.equal(s.options.cwd, pkgDir);
    assert.equal(s.options.stdio, "inherit");
  });

  it("passes --name and --dry-run through", async () => {
    let f = fake({ argv: ["deploy", "--dry-run", "--name", "my-ziwo"] });
    await run(f.io);
    assert.deepEqual(f.seen.spawned[0].args.slice(1), ["deploy", "--config", path.join(pkgDir, "wrangler.jsonc"), "--name", "my-ziwo", "--dry-run"]);
    f = fake({ argv: ["deploy", "--name=other"] });
    await run(f.io);
    assert.deepEqual(f.seen.spawned[0].args.slice(1), ["deploy", "--config", path.join(pkgDir, "wrangler.jsonc"), "--name", "other"]);
  });

  it("turns wrangler's usage metrics off only when the person has not set them, and passes the rest of the environment on", async () => {
    let f = fake({ argv: ["deploy"], env: { PATH: "/bin", HOME: "/home/x" } });
    await run(f.io);
    let env = f.seen.spawned[0].options.env;
    assert.equal(env.WRANGLER_SEND_METRICS, "false");
    assert.equal(env.PATH, "/bin");
    assert.equal(env.HOME, "/home/x");
    f = fake({ argv: ["deploy"], env: { PATH: "/bin", WRANGLER_SEND_METRICS: "true" } });
    await run(f.io);
    env = f.seen.spawned[0].options.env;
    assert.equal(env.WRANGLER_SEND_METRICS, "true");
    // and does not change the environment it was given
    assert.equal(f.io.env.WRANGLER_OUTPUT_FILE_PATH, undefined);
  });

  it("has wrangler write what it deployed into the package's .wrangler, reads the address there, and removes the file", async () => {
    const f = fake({ argv: ["deploy"], written: deployLine(["https://ziwo.someone.workers.dev"]) });
    assert.equal(await run(f.io), 0);
    const file = path.join(pkgDir, ".wrangler", "ziwo-deploy-abc123.json");
    assert.equal(f.seen.spawned[0].options.env.WRANGLER_OUTPUT_FILE_PATH, file);
    assert.deepEqual(f.seen.read, [file]);
    assert.deepEqual(f.seen.removed, [file]);
    assert.equal(f.seen.err, "");
    assert.equal(f.seen.out, `
ziwo is deployed at https://ziwo.someone.workers.dev

If this is a new deployment: open that address in a browser now and choose
your admin secret. The page offers this for one hour.
If you are updating: nothing else to do. Your memories are untouched.

To update later, run the same command again:  npx ziwo@latest deploy
`);
  });

  it("says it in Chinese", async () => {
    const f = fake({ argv: ["deploy"], env: { LANG: "zh_CN.UTF-8" }, written: deployLine(["https://ziwo.someone.workers.dev"]) });
    assert.equal(await run(f.io), 0);
    assert.equal(f.seen.out, `
ziwo 已部署到 https://ziwo.someone.workers.dev

如果这是新部署:现在就在浏览器里打开这个地址,设置管理密钥。页面只在一小时内提供这个入口。
如果是更新:不用再做什么,你的记忆没有动。

以后要更新,再运行一次同样的命令:  npx ziwo@latest deploy
`);
  });

  it("names the Worker in the command to update with, when it was deployed under another name", async () => {
    let f = fake({ argv: ["deploy", "--name", "second"], written: deployLine(["https://second.someone.workers.dev"]) });
    assert.equal(await run(f.io), 0);
    assert.match(f.seen.out, /run the same command again:  npx ziwo@latest deploy --name second\n$/);
    f = fake({ argv: ["deploy", "--name=second"], env: { LANG: "zh_CN.UTF-8" } });
    assert.equal(await run(f.io), 0);
    assert.match(f.seen.out, /再运行一次同样的命令:  npx ziwo@latest deploy --name second\n$/);
  });

  it("points at wrangler's own line when it has no address", async () => {
    for (const written of [undefined, "", "not json\n", deployLine([]), deployLine(["example.com/*"])]) {
      const f = fake({ argv: ["deploy"], written });
      assert.equal(await run(f.io), 0);
      assert.equal(f.seen.out.split("\n")[1], "ziwo is deployed. Its address is on the line above that starts with https://");
      assert.match(f.seen.out, /If you are updating: nothing else to do\. Your memories are untouched\./);
    }
    const f = fake({ argv: ["deploy"], env: { LANG: "zh_CN.UTF-8" } });
    await run(f.io);
    assert.equal(f.seen.out.split("\n")[1], "ziwo 已部署。地址在上面以 https:// 开头的那一行。");
  });

  it("leaves the output file alone when the person asked wrangler for one", async () => {
    for (const env of [{ WRANGLER_OUTPUT_FILE_PATH: "/mine.json" }, { WRANGLER_OUTPUT_FILE_DIRECTORY: "/mine" }]) {
      const f = fake({ argv: ["deploy"], env });
      assert.equal(await run(f.io), 0);
      assert.deepEqual({ ...f.seen.spawned[0].options.env, WRANGLER_SEND_METRICS: undefined }, { ...env, WRANGLER_SEND_METRICS: undefined });
      assert.deepEqual(f.seen.read, []);
      assert.deepEqual(f.seen.removed, []);
      assert.equal(f.seen.out.split("\n")[1], "ziwo is deployed. Its address is on the line above that starts with https://");
    }
  });

  it("after a dry run says that nothing was deployed, and asks for no output file", async () => {
    let f = fake({ argv: ["deploy", "--dry-run"] });
    assert.equal(await run(f.io), 0);
    assert.equal(f.seen.out, "\nDry run: nothing was deployed.\n");
    assert.equal(f.seen.spawned[0].options.env.WRANGLER_OUTPUT_FILE_PATH, undefined);
    f = fake({ argv: ["deploy", "--dry-run"], env: { LC_ALL: "zh_CN.UTF-8" } });
    assert.equal(await run(f.io), 0);
    assert.equal(f.seen.out, "\n试运行:没有部署任何东西。\n");
  });

  it("returns wrangler's exit code, and says where to ask for help when it failed", async () => {
    let f = fake({ argv: ["deploy"], end: { code: 3 }, written: deployLine(["https://ziwo.someone.workers.dev"]) });
    assert.equal(await run(f.io), 3);
    assert.equal(f.seen.out, "");
    assert.equal(f.seen.err, "\nThe deployment did not finish. The lines above say why; include them when asking for help: https://github.com/nilzx/ziwo/issues\n");
    assert.equal(f.seen.removed.length, 1);
    f = fake({ argv: ["deploy", "--dry-run"], end: { code: 1 }, env: { LANG: "zh_CN.UTF-8" } });
    assert.equal(await run(f.io), 1);
    assert.equal(f.seen.err, "\n部署没有完成。原因在上面的输出里;求助时请把它们一起发出来: https://github.com/nilzx/ziwo/issues\n");
    f = fake({ argv: ["deploy"], end: { code: null, signal: "SIGINT" } });
    assert.equal(await run(f.io), 130);
    assert.match(f.seen.err, /The deployment did not finish/);
    for (const end of [{ error: true }, { throws: true }]) {
      f = fake({ argv: ["deploy"], end });
      assert.equal(await run(f.io), 1);
      assert.match(f.seen.err, /The deployment did not finish/);
    }
  });

  it("finds the https address among wrangler's output entries", () => {
    assert.equal(address(deployLine(["https://a.b.workers.dev", "example.com/*"])), "https://a.b.workers.dev");
    assert.equal(address(deployLine(["example.com/*", "https://x.example"])), "https://x.example");
    assert.equal(address(`${deployLine(["https://old.workers.dev"])}${deployLine(["https://new.workers.dev"])}`), "https://new.workers.dev");
    assert.equal(address(JSON.stringify({ type: "version-upload", targets: ["https://a.workers.dev"] })), undefined);
    assert.equal(address("{"), undefined);
  });
});

describe("the installed command, with a stand-in wrangler", () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let pkg;
  // The stand-in records how it was run and ends as STANDIN_EXIT says; it
  // reads a line from its standard input and echoes it, which it can only
  // get when the terminal is handed on.
  const standIn = `
const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
fs.writeFileSync(process.env.STANDIN_RECORD, JSON.stringify({
  argv: process.argv.slice(1), execPath: process.execPath, cwd: process.cwd(),
  metrics: process.env.WRANGLER_SEND_METRICS, output: process.env.WRANGLER_OUTPUT_FILE_PATH,
}));
process.stdout.write("wrangler read: " + input);
if (process.env.WRANGLER_OUTPUT_FILE_PATH) {
  fs.mkdirSync(require("path").dirname(process.env.WRANGLER_OUTPUT_FILE_PATH), { recursive: true });
  fs.appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({ type: "deploy", targets: ["https://ziwo.standin.workers.dev"] }) + "\\n");
}
process.exit(Number(process.env.STANDIN_EXIT || 0));
`;

  before(async () => {
    dir = await scratch("ziwo-npm-cli-");
    pkg = path.join(dir, "node_modules", "ziwo");
    await mkdir(path.join(pkg, "bin"), { recursive: true });
    await mkdir(path.join(pkg, "lib"));
    await cp(path.join(workerDir, "npm", "bin", "ziwo.mjs"), path.join(pkg, "bin", "ziwo.mjs"));
    await cp(path.join(workerDir, "npm", "lib", "cli.mjs"), path.join(pkg, "lib", "cli.mjs"));
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "ziwo", version: "9.8.7", type: "module", engines: { node: ">=22.12.0" }, dependencies: { wrangler: "4.160.0" } }));
    await writeFile(path.join(pkg, "wrangler.jsonc"), "{}\n");
    const w = path.join(dir, "node_modules", "wrangler");
    await mkdir(path.join(w, "bin"), { recursive: true });
    await writeFile(path.join(w, "package.json"), JSON.stringify({ name: "wrangler", version: "4.160.0", bin: { wrangler: "./bin/wrangler.js", "cf-wrangler": "./bin/other.js" } }));
    await writeFile(path.join(w, "bin", "wrangler.js"), standIn);
  });
  after(() => removeScratch(dir));

  /** @param {string[]} args @param {Record<string, string>} env */
  const ziwo = (args, env = {}) => {
    const record = path.join(dir, "record.json");
    const res = spawnSync(process.execPath, [path.join(pkg, "bin", "ziwo.mjs"), ...args], {
      cwd: dir, encoding: "utf8", input: "an answer\n",
      env: { PATH: process.env.PATH ?? "", LANG: "en_US.UTF-8", STANDIN_RECORD: record, ...env },
    });
    return { ...res, record: () => JSON.parse(readFileSync(record, "utf8")) };
  };

  it("prints its version from its package.json", () => {
    const r = ziwo(["--version"]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "9.8.7\n");
  });

  it("runs the wrangler its package.json names, with this node, in the package, handing on the terminal", () => {
    const r = ziwo(["deploy", "--name", "standin"]);
    assert.equal(r.status, 0, r.stderr);
    const rec = r.record();
    assert.deepEqual(rec.argv, [path.join(dir, "node_modules", "wrangler", "bin", "wrangler.js"), "deploy", "--config", path.join(pkg, "wrangler.jsonc"), "--name", "standin"]);
    assert.equal(rec.execPath, process.execPath);
    assert.equal(rec.cwd, pkg);
    assert.equal(rec.metrics, "false");
    assert.equal(path.dirname(rec.output), path.join(pkg, ".wrangler"));
    assert.ok(r.stdout.startsWith("wrangler read: an answer\n"), r.stdout);
    assert.match(r.stdout, /\nziwo is deployed at https:\/\/ziwo\.standin\.workers\.dev\n/);
  });

  it("leaves no output file behind", async () => {
    ziwo(["deploy"]);
    assert.deepEqual((await readdir(path.join(pkg, ".wrangler"))).filter((f) => f.startsWith("ziwo-deploy-")), []);
  });

  it("exits with wrangler's code", () => {
    const r = ziwo(["deploy", "--dry-run"], { STANDIN_EXIT: "7", WRANGLER_SEND_METRICS: "true" });
    assert.equal(r.status, 7);
    assert.equal(r.record().metrics, "true");
    assert.equal(r.record().output, undefined);
    assert.match(r.stderr, /The deployment did not finish\./);
  });
});

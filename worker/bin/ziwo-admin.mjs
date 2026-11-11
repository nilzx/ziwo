#!/usr/bin/env node
// ziwo-admin runs a ziwo deployment from a terminal, through its admin API.
// Node's standard library only, and the page's own modules: the same calls,
// and the same sealing, as the admin page.
//
// It never prints or writes the admin secret, a token it did not just
// create, or an export in the clear: an export is sealed before it is
// written, and an import is opened in memory and sent.

import { constants } from "node:fs";
import { open as openFile, readFile } from "node:fs/promises";
import { stdin, stderr, stdout } from "node:process";
import { ApiError, makeApi, paramNames, reportText, sealedFileName, utcStamp } from "../page/logic.mjs";
import { minPassphrase, open, seal, SealError } from "../page/seal.mjs";

const usage = `ziwo-admin runs a ziwo deployment through its admin API.

Usage:
  ziwo-admin list                     list the memories with their figures
  ziwo-admin new <name>               create a memory and print its token, once
  ziwo-admin token <name>             replace a memory's token and print the new one, once
  ziwo-admin show <name>              show a memory's figures, address and settings
  ziwo-admin set <name> <key>=<value>...
                                      change settings: timeZone=<IANA name> and any of
                                      ${paramNames.join(", ")}
  ziwo-admin check <name>             look a memory over, without showing what it says
  ziwo-admin rebuild <name>           rebuild a memory's tables from its event log
  ziwo-admin export <name> [-o file]  write the memory to a sealed file, as a backup
  ziwo-admin import <name> <file>     bring a sealed export back as a new memory
  ziwo-admin grants <name>            list the clients signed in to a memory (OAuth)
  ziwo-admin revoke <name> <id>       revoke one of them, by the id grants shows
  ziwo-admin delete <name> <name>     delete a memory for good: give its name twice

Environment:
  ZIWO_URL            the deployment's address, such as https://ziwo.example.workers.dev
  ZIWO_ADMIN_SECRET   its ADMIN_SECRET
  ZIWO_PASSPHRASE     the passphrase of an export; asked for, without echo, when unset

Changing a forgetting parameter replays the whole memory from its log.
A client approved a moment ago can take some seconds to show up in grants.
Deleting cannot be undone: export the memory first; an export is the only way back.
`;

// UsageError is a mistake in the command line; it exits 2, as Go's flag
// package does.
class UsageError extends Error {}

/** @param {string} s */
const out = (s) => stdout.write(s.endsWith("\n") ? s : `${s}\n`);

// base reads ZIWO_URL. A secret is never sent in the clear to another
// machine: plain http is for this machine only.
function base() {
  const raw = process.env.ZIWO_URL ?? "";
  if (raw === "") throw new UsageError("set ZIWO_URL to the deployment's address, such as https://ziwo.example.workers.dev");
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`ZIWO_URL is not an address: ${JSON.stringify(raw)}`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new UsageError("ZIWO_URL must start with https:// (plain http:// only for localhost)");
  }
  return u.origin + u.pathname.replace(/\/+$/, "");
}

function api() {
  const secret = process.env.ZIWO_ADMIN_SECRET ?? "";
  if (secret === "") throw new UsageError("set ZIWO_ADMIN_SECRET to the deployment's admin secret");
  const b = base();
  return { api: makeApi({ base: b, secret }), base: b };
}

/** @param {string[]} args @param {number} n @param {string} what */
function positional(args, n, what) {
  if (args.length !== n) throw new UsageError(`give ${what}`);
  return args;
}

/** @param {(string | number)[][]} rows */
function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(widths[i]))).join("  ").trimEnd()).join("\n");
}

/** @param {number | null} ms */
const when = (ms) => (ms === null || ms === undefined ? "never" : utcStamp(ms));

// What was typed after the end of the last line asked for: a paste of two
// lines arrives as one chunk.
let typedAhead = "";

// askHidden reads a line from the terminal without showing it.
/** @param {string} prompt @returns {Promise<string>} */
function askHidden(prompt) {
  if (!stdin.isTTY) {
    return Promise.reject(new UsageError("set ZIWO_PASSPHRASE, or run in a terminal to be asked for the passphrase"));
  }
  // Echo goes off before the prompt shows, so nothing typed is ever shown.
  stdin.setRawMode(true);
  stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let got = "";
    let ended = false;
    /** @param {string} chunk */
    const take = (chunk) => {
      const chars = Array.from(chunk);
      for (let i = 0; i < chars.length && !ended; i++) {
        const ch = chars[i];
        if (ch === "\r" || ch === "\n") {
          typedAhead = chars.slice(i + (ch === "\r" && chars[i + 1] === "\n" ? 2 : 1)).join("");
          end(() => resolve(got));
        } else if (ch === "\u0003") {
          end(() => reject(new Error("interrupted")));
        } else if (ch === "\u007f" || ch === "\b") {
          got = Array.from(got).slice(0, -1).join("");
        } else {
          got += ch;
        }
      }
    };
    /** @param {() => void} settle */
    const end = (settle) => {
      ended = true;
      stdin.off("data", take);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      settle();
    };
    stdin.setEncoding("utf8");
    stdin.on("data", take);
    stdin.resume();
    const ahead = typedAhead;
    typedAhead = "";
    take(ahead);
  });
}

/** @param {boolean} twice */
async function passphrase(twice) {
  const env = process.env.ZIWO_PASSPHRASE;
  if (env !== undefined && env !== "") return env;
  const p = await askHidden("Passphrase: ");
  if (twice && (await askHidden("Passphrase again: ")) !== p) throw new Error("the two passphrases differ");
  return p;
}

/** @param {string} token @param {string} note @param {string} address */
function printToken(token, note, address) {
  out(`address  ${address}\ntoken    ${token}\n${note}\nIt cannot be shown again: keep it now, as you would a password.`);
}

/** @type {Record<string, (args: string[]) => Promise<number | void>>} */
const commands = {
  async list(args) {
    positional(args, 0, "no arguments to list");
    const { api: a } = api();
    const { memories } = await a.list();
    if (memories.length === 0) {
      out("no memories yet; create one with: ziwo-admin new <name>");
      return;
    }
    /** @type {(string | number)[][]} */
    const rows = [["NAME", "MEMORIES", "EVENTS", "LAST EVENT", "TOKEN", "CREATED"]];
    for (const m of memories) {
      if (typeof m.error === "string") rows.push([m.name, "", "", "", "", m.error]);
      else rows.push([m.name, m.memories, m.events, when(m.lastEventAt), m.hasToken ? "set" : "not set", when(m.createdAt)]);
    }
    out(table(rows));
  },

  async new(args) {
    const [name] = positional(args, 1, "the name of the new memory");
    const { api: a, base: b } = api();
    const r = await a.create(name);
    out(`created ${r.memory}`);
    printToken(r.token, r.note, b + r.endpoint);
  },

  async token(args) {
    const [name] = positional(args, 1, "the name of the memory");
    const { api: a, base: b } = api();
    const r = await a.newToken(name);
    out(`new token for ${r.memory}`);
    printToken(r.token, r.note, b + r.endpoint);
  },

  async show(args) {
    const [name] = positional(args, 1, "the name of the memory");
    const { api: a, base: b } = api();
    const m = await a.describe(name);
    out(table([
      ["memory", m.memory],
      ["address", b + m.endpoint],
      ["memories", m.memories],
      ["events", m.events],
      ["last event", when(m.lastEventAt)],
      ["token", m.hasToken ? "set" : "not set"],
      ["timeZone", m.timeZone],
      ...paramNames.map((p) => [p, m.params[p]]),
    ]));
  },

  async set(args) {
    if (args.length < 2) throw new UsageError("give the name of the memory and at least one <key>=<value>");
    const [name, ...pairs] = args;
    /** @type {{ params?: Record<string, number>, timeZone?: string }} */
    const change = {};
    for (const pair of pairs) {
      const at = pair.indexOf("=");
      if (at <= 0) throw new UsageError(`not a <key>=<value>: ${JSON.stringify(pair)}`);
      const key = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (key === "timeZone") {
        change.timeZone = value;
      } else if (paramNames.includes(key)) {
        const n = value.trim() === "" ? Number.NaN : Number(value);
        if (!Number.isFinite(n)) throw new UsageError(`${key} must be a number, got ${JSON.stringify(value)}`);
        change.params = { ...change.params, [key]: n };
      } else {
        throw new UsageError(`unknown setting ${JSON.stringify(key)}: give timeZone or one of ${paramNames.join(", ")}`);
      }
    }
    const { api: a } = api();
    const r = await a.settings(name, change);
    out(table([["memory", r.memory], ["timeZone", r.timeZone], ...paramNames.map((p) => [p, r.params[p]])]));
    if (change.params !== undefined) out("The memory was replayed with these values.");
  },

  async check(args) {
    const [name] = positional(args, 1, "the name of the memory");
    const { api: a } = api();
    const r = await a.check(name);
    stdout.write(reportText(r));
    const problems = r.findings.filter((/** @type {{ level: string }} */ f) => f.level === "problem").length;
    if (problems > 0) {
      stderr.write(`ziwo-admin check: ${problems} problem(s) found in ${JSON.stringify(name)}\n`);
      return 1;
    }
  },

  async rebuild(args) {
    const [name] = positional(args, 1, "the name of the memory");
    const { api: a } = api();
    const r = await a.rebuild(name);
    out(`rebuilt ${r.memories} memories from ${r.events} events`);
  },

  async export(args) {
    let file = "";
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-o") {
        file = args[++i] ?? "";
        if (file === "") throw new UsageError("-o needs a file name");
      } else rest.push(args[i]);
    }
    const [name] = positional(rest, 1, "the name of the memory, and -o <file> if you like");
    const { api: a } = api();
    const pass = await passphrase(true);
    // Refused before anything is fetched, in Go's words.
    if (new TextEncoder().encode(pass).length < minPassphrase) {
      throw new SealError("short-passphrase", `the passphrase must be at least ${minPassphrase} characters`);
    }
    const got = await a.exportClear(name);
    let sealed;
    try {
      sealed = await seal(got.bytes, pass);
    } finally {
      got.bytes.fill(0);
    }
    if (file === "") file = sealedFileName(got.disposition, name, Date.now());
    // Never over a file that is there, and readable by its owner alone.
    let fh;
    try {
      fh = await openFile(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === "EEXIST") throw new Error(`${file} already exists`);
      throw err;
    }
    try {
      await fh.writeFile(sealed);
    } finally {
      await fh.close();
    }
    out(`exported ${JSON.stringify(name)} to ${file} (${sealed.length} bytes, sealed)\nIt opens only with its passphrase. Keep both.`);
  },

  async grants(args) {
    const [name] = positional(args, 1, "the name of the memory");
    const { api: a } = api();
    const { grants } = await a.grants(name);
    if (grants.length === 0) {
      out(`no client has signed in to ${name}; one approved a moment ago can take some seconds to show up`);
      return;
    }
    /** @type {(string | number)[][]} */
    const rows = [["ID", "APPROVED", "LAPSES UNLESS USED", "CLIENT"]];
    for (const g of grants) rows.push([g.id, when(g.createdAt), g.expiresAt === null ? "not yet used" : when(g.expiresAt), g.client]);
    out(table(rows));
  },

  async revoke(args) {
    const [name, id] = positional(args, 2, "the name of the memory and the id of the grant, as grants shows it");
    const { api: a } = api();
    const r = await a.revokeGrant(name, id);
    out(`revoked ${r.revoked} from ${r.memory}\nIts client is refused at its next request; Cloudflare may take a minute or so to carry that everywhere.`);
  },

  async delete(args) {
    const [name, again] = positional(args, 2, "the name of the memory twice, to confirm: ziwo-admin delete <name> <name>");
    if (again !== name) throw new UsageError(`the two names differ: give the name of the memory twice, to confirm`);
    const { api: a } = api();
    const r = await a.deleteMemory(name, again);
    out(`deleted ${r.memory}: ${r.revokedGrants} signed-in client(s) revoked; the name is free`);
  },

  async import(args) {
    const [name, file] = positional(args, 2, "the new memory's name and the sealed export file");
    const { api: a, base: b } = api();
    const sealed = await readFile(file);
    const pass = await passphrase(false);
    const clear = await open(sealed, pass);
    let r;
    try {
      r = await a.importClear(name, clear);
    } finally {
      clear.fill(0);
    }
    out(`brought back ${r.memories} memories from ${r.events} events, as exported on ${utcStamp(r.exportedAt)}`);
    if (typeof r.token === "string") printToken(r.token, r.note, b + r.endpoint);
    else out(`address  ${b + r.endpoint}\n${r.note}`);
  },
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === undefined || cmd === "help" || cmd === "-h" || cmd === "--help") {
    stdout.write(usage);
    return cmd === undefined ? 2 : 0;
  }
  const run = Object.hasOwn(commands, cmd) ? commands[cmd] : undefined;
  if (run === undefined) {
    stderr.write(`ziwo-admin: unknown command ${JSON.stringify(cmd)}\n\n${usage}`);
    return 2;
  }
  try {
    const code = await run(args);
    return typeof code === "number" ? code : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`ziwo-admin ${cmd}: ${err.message}\n`);
      return 2;
    }
    // An answer of the API, a sealing failure, or a file: the message as it came.
    let message = err instanceof ApiError || err instanceof SealError || err instanceof Error ? err.message : String(err);
    // fetch says only "fetch failed"; why is in its cause.
    if (err instanceof TypeError && err.cause instanceof Error) message += `: ${err.cause.message}`;
    stderr.write(`ziwo-admin ${cmd}: ${message}\n`);
    return 1;
  }
}

process.exitCode = await main();

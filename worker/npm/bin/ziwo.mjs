#!/usr/bin/env node
// The `ziwo` command. What it does is in ../lib/cli.mjs; this file only
// hands it the real process, file system and wrangler.

import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { readFileSync, unlinkSync } from "fs";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import { run } from "../lib/cli.mjs";

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));

/** The package's own wrangler: the file its package.json names as the bin. */
function wrangler() {
  const require = createRequire(path.join(packageDir, "package.json"));
  const manifest = require.resolve("wrangler/package.json");
  const bin = JSON.parse(readFileSync(manifest, "utf8")).bin;
  return path.join(path.dirname(manifest), typeof bin === "string" ? bin : bin.wrangler);
}

run({
  argv: process.argv.slice(2),
  env: process.env,
  nodeVersion: process.versions.node,
  execPath: process.execPath,
  packageDir,
  version: pkg.version,
  nodeRange: pkg.engines && pkg.engines.node,
  wrangler,
  spawn: (command, args, options) => {
    const child = spawn(command, args, options);
    // Ctrl-C reaches wrangler too: let it decide, and say afterwards how it ended.
    const wait = () => {};
    process.on("SIGINT", wait);
    child.on("exit", () => process.removeListener("SIGINT", wait));
    return child;
  },
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  readFile: (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch (_err) {
      return undefined;
    }
  },
  removeFile: (file) => {
    try {
      unlinkSync(file);
    } catch (_err) {
      // never written
    }
  },
  intlLocale: () => Intl.DateTimeFormat().resolvedOptions().locale,
  token: () => randomBytes(6).toString("hex"),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  },
);

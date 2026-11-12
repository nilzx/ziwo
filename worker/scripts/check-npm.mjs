// The check of the npm package before it is published. From worker/:
//
//   npm run check:npm
//
// 1. Assembles worker/pkg/ (scripts/pack-npm.mjs).
// 2. Lists what `npm pack --dry-run` would put in the tarball and fails on
//    any file missing or unexpected.
// 3. Packs the tarball into a scratch directory under /private/tmp/, installs
//    it there (this fetches wrangler from the npm registry, into a cache in the
//    scratch directory), and runs the installed `ziwo --version`, `ziwo
//    --help`, and `ziwo deploy --dry-run --name ziwo-check` in English and in
//    Chinese, with a home directory of its own in the scratch directory and no
//    CLOUDFLARE_* variables: signed in to nothing, and a dry run creates
//    nothing on Cloudflare.
// 4. Compares what a dry run of the repository's configuration would upload
//    with what a dry run of the installed package's would: module names,
//    types and contents, the metadata (bindings, compatibility date and
//    flags), and the migrations as wrangler reads them. The admin page's
//    modules are also compared with worker/page/ itself.
// 5. Runs scripts/smoke.py against the installed prebuilt Worker, through a
//    configuration without the Workers AI binding written beside it.
//
// It removes its scratch directory when every check passed; when one failed,
// or with --keep, it leaves it and names it. Every wrangler run in it is a dry
// run, or `wrangler dev --local`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { commandName, fixedFiles, jsonc, localConfig, pack, packageName, workerDir } from "./pack-npm.mjs";
import { compareUploads, dryRun, moduleName } from "./upload-form.mjs";

const failures = [];
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok   " : "  FAIL "}${name}`);
  if (!ok) {
    failures.push(name);
    for (const line of detail.split("\n").slice(0, 30)) if (line) console.log(`       | ${line}`);
  }
}

/** @param {string} cmd @param {string[]} args @param {import("node:child_process").SpawnSyncOptions} [opts] */
function sh(cmd, args, opts = {}) {
  // On Windows npm and the installed command are .cmd files, which need a shell.
  const res = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", ...opts });
  if (res.error) throw res.error;
  return { code: res.status, out: String(res.stdout), err: String(res.stderr) };
}

/** @param {string} dir */
async function du(dir) {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) total += (await stat(path.join(e.parentPath, e.name))).size;
  }
  return total;
}
/** npm pack --json gives a list, or since npm 11 or so an object keyed by name. @param {string} out */
function packed1(out) {
  const j = JSON.parse(out);
  return Array.isArray(j) ? j[0] : Object.values(j)[0];
}
const mib = (/** @type {number} */ n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
const kib = (/** @type {number} */ n) => `${(n / 1024).toFixed(1)} KiB`;

async function main() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const base = existsSync("/private/tmp") ? "/private/tmp" : os.tmpdir();
  const scratch = await mkdtemp(path.join(base, "ziwo-check-npm-"));
  const cache = path.join(scratch, "npm-cache");
  const home = path.join(scratch, "home");
  await mkdir(home);
  console.log(`scratch directory: ${scratch}`);

  console.log("1. pack");
  const packed = await pack({ log: (s) => console.log(`  ${s}`) });
  const pkgDir = packed.outDir;

  console.log("2. what npm would publish");
  const listed = sh(npm, ["pack", "--dry-run", "--json", "--cache", cache], { cwd: pkgDir });
  check("npm pack --dry-run", listed.code === 0, listed.err);
  const files = packed1(listed.out).files.map((/** @type {{ path: string }} */ f) => f.path).sort();
  const expected = [...fixedFiles, ...packed.modules].sort();
  const unexpected = files.filter((/** @type {string} */ f) => !expected.includes(f));
  const missing = expected.filter((f) => !files.includes(f));
  check(`the tarball holds exactly the ${expected.length} expected files`, unexpected.length === 0 && missing.length === 0,
    `unexpected: ${unexpected.join(", ") || "none"}\nmissing: ${missing.join(", ") || "none"}`);

  console.log("3. install and run");
  const tar = sh(npm, ["pack", "--json", "--pack-destination", scratch, "--cache", cache], { cwd: pkgDir });
  check("npm pack", tar.code === 0, tar.err);
  const tarball = path.join(scratch, packed1(tar.out).filename);
  const tarSize = (await stat(tarball)).size;
  const installDir = path.join(scratch, "install");
  await mkdir(installDir);
  await writeFile(path.join(installDir, "package.json"), '{ "private": true }\n');
  const inst = sh(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error", "--cache", cache, tarball], { cwd: installDir });
  check("npm install of the tarball", inst.code === 0, inst.err);
  const installed = path.join(installDir, "node_modules", ...packageName.split("/"));
  const installedWrangler = JSON.parse(await readFile(path.join(installDir, "node_modules", "wrangler", "package.json"), "utf8"));
  check(`it installs wrangler ${packed.wrangler}`, installedWrangler.version === packed.wrangler, installedWrangler.version);

  // Signed in to nothing: a home of its own, and no Cloudflare variables.
  /** @type {Record<string, string>} */
  const env = { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), npm_config_cache: cache };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const bin = path.join(installDir, "node_modules", ".bin", process.platform === "win32" ? `${commandName}.cmd` : commandName);
  const ziwo = (/** @type {string[]} */ args, /** @type {Record<string, string>} */ extra = {}) =>
    sh(bin, args, { cwd: scratch, env: { ...env, LC_ALL: "en_US.UTF-8", ...extra } });

  const v = ziwo(["--version"]);
  check(`ziwo --version says ${packed.version}`, v.code === 0 && v.out === `${packed.version}\n`, v.out + v.err);
  const h = ziwo(["--help"]);
  const { help } = await import(pathToFileURL(path.join(installed, "lib", "cli.mjs")).href);
  check("ziwo --help prints the help", h.code === 0 && h.out === help, h.out + h.err);
  const plain = ziwo([]);
  check("ziwo alone prints the help", plain.code === 0 && plain.out === help, plain.out + plain.err);
  const d = ziwo(["deploy", "--dry-run", "--name", "ziwo-check"]);
  check("ziwo deploy --dry-run --name ziwo-check succeeds", d.code === 0 && d.out.includes("--dry-run: exiting now.") && d.out.endsWith("\nDry run: nothing was deployed.\n"),
    `exit ${d.code}\n${d.out.slice(-1500)}\n${d.err.slice(-1500)}`);
  check("with no warning from wrangler", !/WARNING|ERROR/.test(d.out + d.err), (d.out + d.err).split("\n").filter((l) => /WARNING|ERROR/.test(l)).join("\n"));
  check("and wrangler names the Worker's bindings", /env\.MEMORY \(Memory\)/.test(d.out) && /env\.AI\b/.test(d.out), d.out.slice(-1500));
  const z = ziwo(["deploy", "--dry-run", "--name", "ziwo-check"], { LC_ALL: "zh_CN.UTF-8" });
  check("in Chinese, too", z.code === 0 && z.out.endsWith("\n试运行:没有部署任何东西。\n"), `exit ${z.code}\n${z.out.slice(-500)}\n${z.err.slice(-500)}`);

  console.log("4. the packaged upload against the repository's");
  const repoWrangler = path.join(workerDir, "node_modules", "wrangler");
  const normal = await dryRun({
    wrangler: path.join(repoWrangler, "bin", "wrangler.js"), config: path.join(workerDir, "wrangler.jsonc"),
    outfile: path.join(scratch, "upload-repository.form"), cwd: workerDir,
  });
  const packagedRun = await dryRun({
    wrangler: path.join(installDir, "node_modules", "wrangler", "bin", "wrangler.js"), config: path.join(installed, "wrangler.jsonc"),
    outfile: path.join(scratch, "upload-package.form"), cwd: installed, env,
  });
  const { differences, allowed } = compareUploads(normal.upload, packagedRun.upload);
  const parts = packagedRun.upload.parts;
  const bytes = parts.reduce((n, p) => n + p.content.length, 0);
  check(`the uploads are the same: ${parts.length} modules, ${bytes} bytes, metadata keys ${Object.keys(packagedRun.upload.metadata).sort().join(" ")}`,
    differences.length === 0, differences.join("\n"));
  for (const a of allowed) console.log(`       on purpose: ${a}`);
  const types = Object.entries(Object.groupBy(parts, (p) => p.contentType)).map(([t, ps]) => `${ps?.length} ${t}`).join(", ");
  console.log(`       modules by type: ${types}`);

  const { unstable_readConfig: readConfig } = await import(pathToFileURL(path.join(repoWrangler, "wrangler-dist", "cli.js")).href);
  const a = readConfig({ config: path.join(workerDir, "wrangler.jsonc") });
  const b = readConfig({ config: path.join(installed, "wrangler.jsonc") });
  for (const k of ["migrations", "compatibility_date", "compatibility_flags", "durable_objects", "ai", "version_metadata", "kv_namespaces", "name"]) {
    const x = JSON.stringify(k === "kv_namespaces" ? a[k].map(({ id: _id, ...r }) => r) : a[k]);
    const y = JSON.stringify(b[k]);
    check(`configuration ${k} is the same`, x === y, `${x}\n${y}`);
  }

  const pageDir = path.join(workerDir, "page");
  const pageFiles = (await readdir(pageDir)).filter((f) => /\.(html|mjs|css)$/.test(f)).sort();
  const texts = parts.filter((p) => p.contentType === "text/plain");
  /** @type {string[]} */
  const pageProblems = [];
  for (const f of pageFiles) {
    const m = texts.filter((p) => moduleName(p.name).replace(/^[0-9a-f]{40}-/, "") === f);
    if (m.length !== 1) pageProblems.push(`${f}: ${m.length} modules`);
    else if (!m[0].content.equals(await readFile(path.join(pageDir, f)))) pageProblems.push(`${f}: contents differ`);
  }
  check(`the ${texts.length} Text modules are worker/page/'s ${pageFiles.length} files, byte for byte`, pageProblems.length === 0 && texts.length === pageFiles.length,
    pageProblems.join("\n"));

  console.log("5. the smoke suite against the installed prebuilt Worker");
  const local = path.join(installed, "wrangler.local.jsonc");
  const packagedConfig = JSON.parse((await readFile(path.join(installed, "wrangler.jsonc"), "utf8")).replace(/^\/\/.*$/gm, ""));
  await writeFile(local, jsonc("The installed package's configuration without the Workers AI binding, for scripts/smoke.py (written by scripts/check-npm.mjs).", localConfig(packagedConfig)));
  const smoke = sh("python3", [path.join(workerDir, "scripts", "smoke.py"), "--config", local], { cwd: workerDir });
  const tally = /SMOKE: (\d+) passed, (\d+) failed/.exec(smoke.out);
  check(`smoke, on ${path.relative(scratch, local)}: ${tally ? `${tally[1]} passed, ${tally[2]} failed` : "no tally"}`,
    smoke.code === 0 && tally !== null && tally[2] === "0" && smoke.out.includes(`SMOKE: configuration ${local}\n`), smoke.out.split("\n").filter((l) => l.includes("FAIL")).join("\n") + smoke.err.slice(-1000));

  console.log("sizes");
  console.log(`  tarball ${path.basename(tarball)}: ${tarSize} bytes (${kib(tarSize)}), ${files.length} files`);
  console.log(`  installed: the package ${mib(await du(installed))}; with wrangler and its dependencies ${mib(await du(path.join(installDir, "node_modules")))}`);
  if (failures.length > 0) {
    console.log(`scratch directory, left for inspection: ${scratch}`);
    console.log(`CHECK-NPM: ${failures.length} FAILED: ${failures.join("; ")}`);
    process.exit(1);
  }
  // An installed copy is a third of a gigabyte: gone once everything passed.
  if (process.argv.includes("--keep")) {
    console.log(`scratch directory, kept: ${scratch}`);
  } else {
    await rm(scratch, { recursive: true, force: true });
    console.log("scratch directory removed (run with --keep to leave it)");
  }
  console.log("CHECK-NPM: all checks passed");
}

main().catch((err) => {
  console.error(`check-npm: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});

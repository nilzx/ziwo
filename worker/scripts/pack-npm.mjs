// Assembles the npm package `ziwo` in worker/pkg/, ready to publish as it is
// (the publishing itself is done by hand, never here).
//
// The package holds the Worker prebuilt: a dry run of `wrangler deploy` with
// the repository's configuration writes what it would upload to a file
// (--outfile), and the modules in it, byte for byte and with the types they
// are uploaded as, become worker/ in the package, with a configuration that
// uploads them without bundling again. So the person's machine deploys what
// was built and tested here, and installs no dependency but wrangler.
//
// Usage (from worker/):  npm run pack:npm

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dryRun, moduleName, moduleTypes, sourceMapType } from "./upload-form.mjs";

export const workerDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const repoURL = "https://github.com/nilzx/ziwo";

/** The files in the package apart from the prebuilt Worker's modules. */
export const fixedFiles = ["LICENSE", "README.md", "bin/ziwo.mjs", "lib/cli.mjs", "package.json", "wrangler.jsonc"];

/**
 * lockedWrangler reads the exact wrangler version of worker/package-lock.json.
 * @param {string} dir the directory of package-lock.json
 */
export async function lockedWrangler(dir) {
  const lock = JSON.parse(await readFile(path.join(dir, "package-lock.json"), "utf8"));
  const version = lock.packages?.["node_modules/wrangler"]?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`no exact wrangler version in ${dir}/package-lock.json`);
  return version;
}

/**
 * packageJson is the package's package.json.
 * @param {{ version: string, wrangler: string, node: string }} o node: wrangler's engines.node
 */
export function packageJson(o) {
  return {
    name: "ziwo",
    version: o.version,
    description: "A memory of its own for an AI, across the platforms it is used on. This command deploys it to your Cloudflare account, and updates it.",
    license: "MIT",
    type: "module",
    bin: { ziwo: "bin/ziwo.mjs" },
    files: ["bin/", "lib/", "worker/", "wrangler.jsonc"],
    engines: { node: o.node },
    dependencies: { wrangler: o.wrangler },
    repository: { type: "git", url: `git+${repoURL}.git` },
    homepage: repoURL,
  };
}

// Settings that change how wrangler builds or finds modules, or that the
// packaged configuration does not carry over. If the repository's
// configuration takes one up, this script has to learn what to do with it.
const notCarried = [
  "alias", "base_dir", "build", "define", "dependencies_instrumentation", "env", "find_additional_modules", "minify", "no_bundle",
  "preserve_file_names", "site", "assets", "tsconfig", "upload_source_maps", "legacy_env", "node_compat",
];

/**
 * packagedConfig is the package's wrangler configuration: the repository's,
 * with main and rules pointing at the prebuilt modules, no bundling, and no
 * namespace id of the repository owner's account.
 * @param {Record<string, unknown>} raw the repository's configuration, as wrangler reads it
 * @param {import("./upload-form.mjs").Upload} upload
 */
export function packagedConfig(raw, upload) {
  const { $schema: _schema, main: _main, rules: _rules, ...rest } = raw;
  for (const k of notCarried) {
    if (k in rest) throw new Error(`the configuration sets ${k}, which pack-npm does not know how to carry into the package`);
  }
  const main = upload.metadata.main_module;
  if (typeof main !== "string") throw new Error("the upload names no main module");
  /** @type {Map<string, string[]>} */
  const byType = new Map();
  let sawMain = false;
  for (const p of upload.parts) {
    if (p.contentType === sourceMapType) continue;
    const name = moduleName(p.name);
    if (name === main) {
      if (p.contentType !== "application/javascript+module") throw new Error(`the main module is ${p.contentType}`);
      sawMain = true;
      continue;
    }
    const type = moduleTypes[p.contentType];
    if (!type) throw new Error(`module ${name} has a content type pack-npm does not know: ${p.contentType}`);
    byType.set(type, [...(byType.get(type) ?? []), name]);
  }
  if (!sawMain) throw new Error(`the upload has no module ${main}`);
  const kv = rest.kv_namespaces;
  if (kv !== undefined) {
    if (!Array.isArray(kv)) throw new Error("kv_namespaces is not a list");
    // The id wrangler may write back after a first deploy belongs to the
    // account it deployed to; the person's own deploy finds or creates theirs.
    rest.kv_namespaces = kv.map(({ id: _id, preview_id: _pid, ...k }) => k);
  }
  return {
    ...rest,
    main: `worker/${main}`,
    // Exactly the modules of the upload, each with the type it had there.
    // fallthrough false: wrangler's default rules have nothing else to find,
    // and saying so keeps wrangler from warning about it.
    rules: [...byType].map(([type, names]) => ({ type, globs: names.sort(), fallthrough: false })),
    no_bundle: true,
    // The repository's source map stays here.
    upload_source_maps: false,
    // The package.json beside this file lists wrangler, not the Worker's
    // dependencies: do not report it as the Worker's.
    dependencies_instrumentation: { enabled: false },
  };
}

/**
 * localConfig is the packaged configuration without the Workers AI binding,
 * for runs under `wrangler dev --local` that must not reach an account (as
 * wrangler.dev.jsonc is to wrangler.jsonc).
 * @param {Record<string, unknown>} packaged
 */
export function localConfig(packaged) {
  const { ai: _ai, ...rest } = packaged;
  return rest;
}

/** @param {string} header @param {unknown} config */
export function jsonc(header, config) {
  return `${header.trim().split("\n").map((l) => `// ${l}`.trimEnd()).join("\n")}\n${JSON.stringify(config, null, 2)}\n`;
}

const configHeader = `
The ziwo Worker, prebuilt: what \`wrangler deploy\` uploads from
worker/wrangler.jsonc in ${repoURL}, built once when this
package was made. Wrangler uploads worker/ as it is, without bundling again.
Generated by worker/scripts/pack-npm.mjs; do not edit.
`;

/**
 * assemble writes the package into outDir from an upload and the
 * repository's configuration.
 * @param {{
 *   upload: import("./upload-form.mjs").Upload, raw: Record<string, unknown>, outDir: string,
 *   version: string, wrangler: string, node: string, sources?: { npm: string, license: string },
 * }} o
 */
export async function assemble(o) {
  const sources = o.sources ?? { npm: path.join(workerDir, "npm"), license: path.join(workerDir, "..", "LICENSE") };
  if (!/^>=\d+\.\d+\.\d+$/.test(o.node)) throw new Error(`wrangler's engines.node is ${o.node}; the command can check only ">=x.y.z"`);
  const config = packagedConfig(o.raw, o.upload);
  await clean(o.outDir);
  await mkdir(path.join(o.outDir, "worker"), { recursive: true });
  /** @type {string[]} */
  const modules = [];
  for (const p of o.upload.parts) {
    if (p.contentType === sourceMapType) continue;
    const name = moduleName(p.name);
    if (name.includes("/") || name.includes("\\") || name.startsWith(".")) throw new Error(`module name ${name} is not a plain file name`);
    await writeFile(path.join(o.outDir, "worker", name), p.content);
    modules.push(`worker/${name}`);
  }
  await writeFile(path.join(o.outDir, "wrangler.jsonc"), jsonc(configHeader, config));
  await writeFile(path.join(o.outDir, "package.json"), `${JSON.stringify(packageJson(o), null, 2)}\n`);
  await mkdir(path.join(o.outDir, "bin"));
  await mkdir(path.join(o.outDir, "lib"));
  await cp(path.join(sources.npm, "bin", "ziwo.mjs"), path.join(o.outDir, "bin", "ziwo.mjs"));
  await cp(path.join(sources.npm, "lib", "cli.mjs"), path.join(o.outDir, "lib", "cli.mjs"));
  await cp(path.join(sources.npm, "README.md"), path.join(o.outDir, "README.md"));
  await cp(sources.license, path.join(o.outDir, "LICENSE"));
  return { config, modules: modules.sort() };
}

/**
 * clean removes outDir, but only when it is missing, empty, or a package
 * this script wrote.
 * @param {string} dir
 */
async function clean(dir) {
  try {
    await stat(dir);
  } catch {
    return;
  }
  let ours = false;
  try {
    ours = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")).name === "ziwo";
  } catch {
    ours = (await readdir(dir)).length === 0;
  }
  if (!ours) throw new Error(`${dir} exists and is not a package this script wrote; not removing it`);
  await rm(dir, { recursive: true, force: true });
}

/**
 * pack builds the Worker into a fresh directory and assembles the package.
 * @param {{ outDir?: string, log?: (s: string) => void }} [o]
 */
export async function pack(o = {}) {
  const log = o.log ?? ((s) => console.log(s));
  const outDir = o.outDir ?? path.join(workerDir, "pkg");
  const wranglerDir = path.join(workerDir, "node_modules", "wrangler");
  const wranglerPkg = JSON.parse(await readFile(path.join(wranglerDir, "package.json"), "utf8"));
  const locked = await lockedWrangler(workerDir);
  if (wranglerPkg.version !== locked) throw new Error(`installed wrangler is ${wranglerPkg.version}, the lockfile pins ${locked}: run npm ci`);
  const { version } = JSON.parse(await readFile(path.join(workerDir, "package.json"), "utf8"));
  if (typeof version !== "string") throw new Error("worker/package.json has no version");

  // A directory of its own for each build: wrangler does not clean its output.
  const buildDir = path.join(workerDir, ".npm-build");
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(buildDir);
  try {
    const { experimental_readRawConfig: readRawConfig } = await import(pathToFileURL(path.join(wranglerDir, "wrangler-dist", "cli.js")).href);
    const { rawConfig } = readRawConfig({ config: path.join(workerDir, "wrangler.jsonc") });
    const { upload } = await dryRun({
      wrangler: path.join(wranglerDir, wranglerPkg.bin.wrangler),
      config: path.join(workerDir, "wrangler.jsonc"),
      outfile: path.join(buildDir, "upload.form"),
      cwd: workerDir,
    });
    const { modules } = await assemble({ upload, raw: rawConfig, outDir, version, wrangler: locked, node: wranglerPkg.engines.node });
    log(`pack-npm: ziwo ${version} in ${outDir}`);
    log(`  wrangler ${locked}, Node.js ${wranglerPkg.engines.node}`);
    log(`  ${modules.length} modules: ${modules.join(", ")}`);
    return { outDir, version, wrangler: locked, node: wranglerPkg.engines.node, upload, modules };
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  pack().catch((err) => {
    console.error(`pack-npm: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}

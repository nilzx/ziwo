// scripts/pack-npm.mjs: the package it writes, from a made-up upload and the
// repository's real configuration, without running wrangler. (The real build,
// the install and the comparison with the repository's upload are in
// `npm run check:npm`.)

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { assemble, fixedFiles, localConfig, lockedWrangler, packagedConfig } from "../../scripts/pack-npm.mjs";
import { compareUploads, parseUpload } from "../../scripts/upload-form.mjs";
import { removeScratch, scratch, workerDir } from "./go.mjs";

const { version } = JSON.parse(await readFile(path.join(workerDir, "package.json"), "utf8"));
const wranglerPkg = JSON.parse(await readFile(path.join(workerDir, "node_modules", "wrangler", "package.json"), "utf8"));
const { experimental_readRawConfig: readRawConfig } = await import("wrangler");
const raw = () => readRawConfig({ config: path.join(workerDir, "wrangler.jsonc") }).rawConfig;

/** @param {string} name @param {string} contentType @param {string} content */
const part = (name, contentType, content) => ({ name, contentType, content: Buffer.from(content) });
const upload = () => ({
  metadata: { main_module: "index.js", bindings: [] },
  parts: [
    part("index.js", "application/javascript+module", 'import app from "./0123-app.mjs";\n//# sourceMappingURL=index.js.map\n'),
    part("./0123-app.mjs", "text/plain", "export const page = 1;\n"),
    part("./4567-style.css", "text/plain", "body {}\n"),
    part("index.js.map", "application/source-map", "{}"),
  ],
});

describe("the package pack-npm writes", () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let out;
  /** @type {Awaited<ReturnType<typeof assemble>>} */
  let made;
  before(async () => {
    dir = await scratch("ziwo-npm-pack-");
    out = path.join(dir, "pkg");
    const config = raw();
    // as wrangler writes it back after a first deploy
    config.kv_namespaces = [{ binding: "OAUTH_KV", id: "0123456789abcdef0123456789abcdef" }];
    made = await assemble({ upload: upload(), raw: config, outDir: out, version, wrangler: await lockedWrangler(workerDir), node: wranglerPkg.engines.node });
  });
  after(() => removeScratch(dir));

  it("depends on the lockfile's exact wrangler and nothing else", async () => {
    const lock = JSON.parse(await readFile(path.join(workerDir, "package-lock.json"), "utf8"));
    const pinned = lock.packages["node_modules/wrangler"].version;
    assert.match(pinned, /^\d+\.\d+\.\d+$/);
    assert.equal(await lockedWrangler(workerDir), pinned);
    const pkg = JSON.parse(await readFile(path.join(out, "package.json"), "utf8"));
    assert.deepEqual(pkg.dependencies, { wrangler: pinned });
    assert.equal(pkg.devDependencies, undefined);
  });

  it("has the fields npm needs, the command, and wrangler's own Node.js range", async () => {
    const pkg = JSON.parse(await readFile(path.join(out, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(pkg).sort(), ["bin", "dependencies", "description", "engines", "files", "homepage", "license", "name", "publishConfig", "repository", "type", "version"]);
    assert.equal(pkg.name, "@ziwo/memory");
    assert.deepEqual(pkg.publishConfig, { access: "public" });
    assert.equal(pkg.version, version);
    assert.equal(pkg.license, "MIT");
    assert.equal(pkg.type, "module");
    assert.ok(pkg.description.length > 20);
    assert.deepEqual(pkg.bin, { "ziwo-memory": "bin/ziwo.mjs" });
    assert.deepEqual(pkg.files, ["bin/", "lib/", "worker/", "wrangler.jsonc"]);
    assert.deepEqual(pkg.engines, { node: wranglerPkg.engines.node });
    assert.equal(pkg.homepage, "https://github.com/nilzx/ziwo");
    assert.deepEqual(pkg.repository, { type: "git", url: "git+https://github.com/nilzx/ziwo.git" });
  });

  it("holds the command, the README, the license, the configuration and the modules, and no source map", async () => {
    const files = (await readdir(out, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile()).map((e) => path.relative(out, path.join(e.parentPath, e.name)).split(path.sep).join("/")).sort();
    assert.deepEqual(made.modules, ["worker/0123-app.mjs", "worker/4567-style.css", "worker/index.js"]);
    assert.deepEqual(files, [...fixedFiles, ...made.modules].sort());
    assert.equal(await readFile(path.join(out, "LICENSE"), "utf8"), await readFile(path.join(workerDir, "..", "LICENSE"), "utf8"));
    assert.equal(await readFile(path.join(out, "README.md"), "utf8"), await readFile(path.join(workerDir, "npm", "README.md"), "utf8"));
    assert.equal(await readFile(path.join(out, "bin", "ziwo.mjs"), "utf8"), await readFile(path.join(workerDir, "npm", "bin", "ziwo.mjs"), "utf8"));
    assert.equal(await readFile(path.join(out, "worker", "0123-app.mjs"), "utf8"), "export const page = 1;\n");
  });

  it("uploads the modules as they are, each with its type, and nothing of the owner's account", async () => {
    const text = await readFile(path.join(out, "wrangler.jsonc"), "utf8");
    assert.match(text, /^\/\/ /);
    const config = JSON.parse(text.replace(/^\/\/.*$/gm, ""));
    const repo = raw();
    assert.equal(config.main, "worker/index.js");
    assert.equal(config.no_bundle, true);
    assert.equal(config.upload_source_maps, false);
    assert.deepEqual(config.rules, [{ type: "Text", globs: ["0123-app.mjs", "4567-style.css"], fallthrough: false }]);
    assert.equal("$schema" in config, false);
    assert.deepEqual(config.kv_namespaces, [{ binding: "OAUTH_KV" }]);
    for (const k of ["name", "compatibility_date", "compatibility_flags", "ai", "version_metadata", "durable_objects", "migrations"]) {
      assert.deepEqual(config[k], repo[k], k);
    }
    assert.deepEqual(localConfig(config).ai, undefined);
    assert.deepEqual({ ...localConfig(config), ai: config.ai }, config);
  });

  it("refuses settings it does not know how to carry, and a Node.js range the command cannot check", async () => {
    assert.throws(() => packagedConfig({ ...raw(), alias: { a: "b" } }, upload()), /alias/);
    assert.throws(() => packagedConfig(raw(), { ...upload(), parts: upload().parts.slice(1) }), /no module index\.js/);
    assert.throws(() => packagedConfig(raw(), { ...upload(), parts: [...upload().parts, part("x.bin", "application/x-unknown", "")] }), /content type/);
    await assert.rejects(
      assemble({ upload: upload(), raw: raw(), outDir: path.join(dir, "other"), version: "0.1.0", wrangler: "4.160.0", node: "^22 || ^24" }),
      /engines\.node/,
    );
  });
});

describe("the comparison of uploads", () => {
  it("reads wrangler's form back", async () => {
    const form = new FormData();
    form.set("metadata", JSON.stringify({ main_module: "index.js" }));
    form.set("index.js", new Blob(["export default {}"], { type: "application/javascript+module" }), "index.js");
    form.set("./a.mjs", new Blob(["text"], { type: "text/plain" }), "./a.mjs");
    const body = Buffer.from(await new Response(form).arrayBuffer());
    const u = await parseUpload(body);
    assert.deepEqual(u.metadata, { main_module: "index.js" });
    assert.deepEqual(u.parts.map((p) => [p.name, p.contentType, p.content.toString()]), [
      ["index.js", "application/javascript+module", "export default {}"],
      ["./a.mjs", "text/plain", "text"],
    ]);
  });

  it("allows only the source map and the dependency list, and finds any other difference", () => {
    const normal = upload();
    normal.metadata = { ...normal.metadata, package_dependencies: [{ name: "agents" }] };
    const packaged = upload();
    packaged.parts = packaged.parts.filter((p) => p.contentType !== "application/source-map").map((p) => ({ ...p, name: p.name.replace(/^\.\//, "") }));
    const same = compareUploads(normal, packaged);
    assert.deepEqual(same.differences, []);
    assert.equal(same.allowed.length, 2);

    const changed = structuredClone(packaged);
    changed.parts[1].content = Buffer.from("export const page = 2;\n");
    changed.parts[2].contentType = "application/javascript+module";
    changed.metadata.bindings = [{ name: "AI", type: "ai" }];
    changed.parts.push(part("extra.mjs", "text/plain", ""));
    changed.parts.push(part("index.js.map", "application/source-map", "{}"));
    const d = compareUploads(normal, changed).differences;
    assert.equal(d.length, 5, d.join("\n"));
    assert.ok(d.some((x) => x.startsWith("module 0123-app.mjs: contents differ")));
    assert.ok(d.some((x) => x.startsWith("module 4567-style.css: type text/plain")));
    assert.ok(d.some((x) => x.startsWith("metadata.bindings")));
    assert.ok(d.some((x) => x.includes("extra.mjs is only in the package's upload")));
    assert.ok(d.some((x) => x.includes("carries a source map")));
    const missing = structuredClone(packaged);
    missing.parts.pop();
    assert.deepEqual(compareUploads(normal, missing).differences, ["module 4567-style.css is missing from the package's upload"]);
  });
});

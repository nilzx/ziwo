// What `wrangler deploy` would upload: wrangler's --outfile writes the
// request body of the upload (a multipart form: the metadata, then each
// module with its content type) even on a dry run. This file runs such a dry
// run, reads the form back, and compares two of them.
//
// Never run here without --dry-run; every run also names the Worker
// ziwo-check, so that not even a mistake could touch a real deployment.

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

/** The rule type wrangler gives a module, by the content type it uploads it with. */
export const moduleTypes = /** @type {Record<string, string>} */ ({
  "application/javascript+module": "ESModule",
  "application/javascript": "CommonJS",
  "text/plain": "Text",
  "application/octet-stream": "Data",
  "application/wasm": "CompiledWasm",
});

export const sourceMapType = "application/source-map";

/**
 * @typedef {{ name: string, contentType: string, content: Buffer }} Part
 * @typedef {{ metadata: Record<string, unknown>, parts: Part[] }} Upload
 */

/**
 * dryRun runs `wrangler deploy --dry-run` with the given configuration and
 * returns what it would have uploaded.
 * @param {{ wrangler: string, config: string, outfile: string, cwd: string, env?: Record<string, string | undefined> }} o
 *   wrangler: the path of wrangler's bin/wrangler.js; env: the whole
 *   environment to run it in (default: this process's)
 */
export async function dryRun(o) {
  const args = [o.wrangler, "deploy", "--dry-run", "--name", "ziwo-check", "--config", o.config, "--outfile", o.outfile];
  const res = spawnSync(process.execPath, args, {
    cwd: o.cwd,
    encoding: "utf8",
    env: { ...(o.env ?? process.env), WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    throw new Error(`wrangler deploy --dry-run --config ${o.config} failed (${res.status}):\n${res.stdout}\n${res.stderr}`);
  }
  return { upload: await parseUpload(await readFile(o.outfile)), log: res.stdout };
}

/**
 * parseUpload reads a multipart form as wrangler writes it with --outfile.
 * @param {Buffer} body
 * @returns {Promise<Upload>}
 */
export async function parseUpload(body) {
  const firstLine = body.subarray(0, body.indexOf("\r\n")).toString("latin1");
  if (!firstLine.startsWith("--")) throw new Error("not a multipart form");
  const boundary = firstLine.slice(2);
  const form = await new Response(new Uint8Array(body), {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  }).formData();
  /** @type {Record<string, unknown> | undefined} */
  let metadata;
  /** @type {Part[]} */
  const parts = [];
  for (const [name, value] of form.entries()) {
    if (name === "metadata") {
      metadata = JSON.parse(typeof value === "string" ? value : await value.text());
      continue;
    }
    if (typeof value === "string") throw new Error(`form field ${name} is not a file`);
    parts.push({ name, contentType: value.type, content: Buffer.from(await value.arrayBuffer()) });
  }
  if (!metadata) throw new Error("the form has no metadata");
  return { metadata, parts };
}

/** The name a module is imported by: wrangler's bundler writes "./x", the upload of files "x". */
export const moduleName = (/** @type {string} */ name) => name.replace(/^\.\//, "");

/**
 * compareUploads lists every difference between what the repository's
 * configuration uploads (normal) and what the package's uploads (packaged),
 * apart from the two the package makes on purpose: it carries no source
 * map, and its upload does not list the repository's npm dependencies
 * (package_dependencies, which wrangler reads from the package.json next to
 * the configuration).
 * @param {Upload} normal @param {Upload} packaged
 */
export function compareUploads(normal, packaged) {
  /** @type {string[]} */
  const differences = [];
  /** @type {string[]} */
  const allowed = [];

  const { package_dependencies: deps, ...meta } = normal.metadata;
  if (deps !== undefined) allowed.push(`metadata.package_dependencies: ${Array.isArray(deps) ? deps.length : "?"} entries in the repository's upload, none in the package's`);
  if ("package_dependencies" in packaged.metadata) differences.push("the package's upload lists package_dependencies");
  const keys = new Set([...Object.keys(meta), ...Object.keys(packaged.metadata)]);
  keys.delete("package_dependencies");
  for (const k of [...keys].sort()) {
    const a = JSON.stringify(meta[k]);
    const b = JSON.stringify(packaged.metadata[k]);
    if (a !== b) differences.push(`metadata.${k}: ${a} != ${b}`);
  }

  /** @param {Upload} u */
  const byName = (u) => {
    /** @type {Map<string, Part>} */
    const m = new Map();
    for (const p of u.parts) {
      const n = moduleName(p.name);
      if (m.has(n)) differences.push(`module ${n} appears twice`);
      m.set(n, p);
    }
    return m;
  };
  const a = byName(normal);
  const b = byName(packaged);
  for (const [n, p] of a) {
    if (p.contentType === sourceMapType) {
      allowed.push(`${n} (${p.content.length} bytes, a source map) is in the repository's upload, not the package's`);
      continue;
    }
    const q = b.get(n);
    if (!q) {
      differences.push(`module ${n} is missing from the package's upload`);
      continue;
    }
    if (p.contentType !== q.contentType) differences.push(`module ${n}: type ${p.contentType} != ${q.contentType}`);
    if (!p.content.equals(q.content)) differences.push(`module ${n}: contents differ (${p.content.length} != ${q.content.length} bytes)`);
  }
  for (const [n, q] of b) {
    if (q.contentType === sourceMapType) differences.push(`the package's upload carries a source map, ${n}`);
    else if (!a.has(n)) differences.push(`module ${n} is only in the package's upload`);
  }
  return { differences, allowed };
}

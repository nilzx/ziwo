// Paths and scratch directories shared by the Node tests.

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const repoRoot = path.resolve(workerDir, "..");

/** @param {string} prefix */
export async function scratch(prefix) {
  const base = existsSync("/private/tmp") ? "/private/tmp" : os.tmpdir();
  return mkdtemp(path.join(base, prefix));
}

/** @param {string} dir */
export const removeScratch = (dir) => rm(dir, { recursive: true, force: true });

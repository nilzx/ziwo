// The Go build, for tests that check the Worker's side against it: a small
// program that seals and opens with Go's internal/sealed, and the ziwo
// command itself. Both are built into a scratch directory under /private/tmp;
// the helper's source is laid over the repository with go build -overlay, so
// nothing is written into the Go tree. Without a go command these return
// null and the tests that need them are skipped.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

export function haveGo() {
  return spawnSync("go", ["version"], { stdio: "ignore" }).status === 0 && existsSync(path.join(repoRoot, "internal/sealed/sealed.go"));
}

const helperSource = `package main

import (
	"fmt"
	"io"
	"os"

	"github.com/nilzx/ziwo/internal/sealed"
)

// seal or open stdin with the passphrase in SEAL_PASS; Go's error on stderr.
func main() {
	in, err := io.ReadAll(os.Stdin)
	if err != nil {
		panic(err)
	}
	var out []byte
	if os.Args[1] == "seal" {
		out, err = sealed.Seal(in, os.Getenv("SEAL_PASS"))
	} else {
		out, err = sealed.Open(in, os.Getenv("SEAL_PASS"))
	}
	if err != nil {
		fmt.Fprint(os.Stderr, err)
		os.Exit(3)
	}
	os.Stdout.Write(out)
}
`;

/**
 * buildSealHelper builds the helper into dir and returns its path.
 * @param {string} dir
 */
export async function buildSealHelper(dir) {
  const virtual = path.join(repoRoot, "cmd", `zz-seal-helper-${path.basename(dir)}`, "main.go");
  const source = path.join(dir, "main.go");
  const overlay = path.join(dir, "overlay.json");
  await writeFile(source, helperSource);
  await writeFile(overlay, JSON.stringify({ Replace: { [virtual]: source } }));
  const bin = path.join(dir, "seal-helper");
  execFileSync("go", ["build", "-overlay", overlay, "-o", bin, `./${path.relative(repoRoot, path.dirname(virtual))}`], { cwd: repoRoot, stdio: "pipe" });
  return bin;
}

/**
 * goSeal runs the helper: "seal" or "open" the input with the passphrase.
 * @param {string} bin @param {"seal" | "open"} op @param {Uint8Array} input @param {string} pass
 * @returns {{ ok: true, out: Buffer } | { ok: false, error: string }}
 */
export function goSeal(bin, op, input, pass) {
  const r = spawnSync(bin, [op], { input, env: { SEAL_PASS: pass }, maxBuffer: 64 << 20 });
  return r.status === 0 ? { ok: true, out: r.stdout } : { ok: false, error: r.stderr.toString() };
}

/**
 * buildZiwo builds the Go ziwo command into dir and returns its path.
 * @param {string} dir
 */
export function buildZiwo(dir) {
  const bin = path.join(dir, "ziwo");
  execFileSync("go", ["build", "-o", bin, "./cmd/ziwo"], { cwd: repoRoot, stdio: "pipe" });
  return bin;
}

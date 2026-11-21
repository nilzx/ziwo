import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Canonical SemVer without build metadata, which npm does not preserve as a
// distinct published version. Numeric prerelease identifiers cannot have zeros
// before another digit. The accepted characters are also safe for CI outputs.
export function releaseChannel(version) {
  const match = typeof version === "string" && version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/);
  if (!match || match[0] !== version || match[4]?.split(".").some(id => /^\d+$/.test(id) && id.length > 1 && id.startsWith("0"))) {
    throw new Error("The package version must be canonical SemVer without build metadata");
  }
  return match[4] ? "next" : "latest";
}

export function releasePlan({ version, eventName, refType, refName }) {
  const channel = releaseChannel(version);
  if (refType === "tag" && refName !== `v${version}`) throw new Error("The Git tag must exactly match the package version");
  return { version, channel, prerelease: channel === "next", publish: eventName === "push" && refType === "tag" };
}

export async function main(env = process.env) {
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const plan = releasePlan({ version, eventName: env.GITHUB_EVENT_NAME, refType: env.GITHUB_REF_TYPE, refName: env.GITHUB_REF_NAME });
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, Object.entries(plan).map(([key, value]) => `${key}=${value}\n`).join(""));
  process.stdout.write(JSON.stringify(plan) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

// The `ziwo` command of the npm package: `ziwo deploy` runs the package's own
// wrangler on the prebuilt Worker and says what to do next. Everything it
// does to the world goes through `io`, which bin/ziwo.mjs fills in, so that
// the tests can drive it with stand-ins.
//
// Kept to syntax and modules that old Node.js versions load, so that the
// version check below can still speak on them.

import path from "path";

const repo = "https://github.com/nilzx/ziwo";

// How the command is run: through npx, by the package's name on npm.
const npx = "npx @ziwo/memory@latest";

export const help = `ziwo: a memory of its own for an AI. This command runs it in your Cloudflare account.

  ${npx} deploy      deploy, or update, ziwo
      --name <name>                   deploy under another Worker name (default: ziwo)
      --dry-run                       build and check, deploy nothing
  ${npx} --version

${repo}
`;

/** @type {Record<"en" | "zh", Record<string, (v: Record<string, string>) => string>>} */
export const texts = {
  en: {
    deployedAt: (v) => `ziwo is deployed at ${v.address}`,
    deployedSomewhere: () => "ziwo is deployed. Its address is on the line above that starts with https://",
    next: (v) =>
      "If this is a new deployment: open that address in a browser now and choose\n" +
      "your admin secret. The page offers this for one hour.\n" +
      "If you are updating: nothing else to do. Your memories are untouched.\n" +
      "\n" +
      `To update later, run the same command again:  ${v.command}`,
    dryRun: () => "Dry run: nothing was deployed.",
    failed: () => `The deployment did not finish. The lines above say why; include them when asking for help: ${repo}/issues`,
    oldNode: (v) => `ziwo needs Node.js ${v.needed} or later; this is ${v.found}. Get the current version from https://nodejs.org and run the command again.`,
    unknown: (v) => `ziwo does not know "${v.arg}".`,
    noName: () => "--name needs a Worker name after it.",
  },
  zh: {
    deployedAt: (v) => `ziwo 已部署到 ${v.address}`,
    deployedSomewhere: () => "ziwo 已部署。地址在上面以 https:// 开头的那一行。",
    next: (v) =>
      "如果这是新部署:现在就在浏览器里打开这个地址,设置管理密钥。页面只在一小时内提供这个入口。\n" +
      "如果是更新:不用再做什么,你的记忆没有动。\n" +
      "\n" +
      `以后要更新,再运行一次同样的命令:  ${v.command}`,
    dryRun: () => "试运行:没有部署任何东西。",
    failed: () => `部署没有完成。原因在上面的输出里;求助时请把它们一起发出来: ${repo}/issues`,
    oldNode: (v) => `ziwo 需要 Node.js ${v.needed} 或更高版本,当前是 ${v.found}。请到 https://nodejs.org 安装最新版本,然后再运行一次。`,
    unknown: (v) => `ziwo 不认识"${v.arg}"。`,
    noName: () => "--name 后面要跟一个 Worker 名称。",
  },
};

/**
 * language picks Chinese when the system's locale is Chinese: the first of
 * LC_ALL, LC_MESSAGES and LANG that names a language decides, then the
 * locale Intl reports. "C" and "POSIX" name no language.
 * @param {Record<string, string | undefined>} env
 * @param {() => string} intlLocale
 * @returns {"en" | "zh"}
 */
export function language(env, intlLocale) {
  for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const value = (env[name] || "").trim();
    if (value === "" || /^(C|POSIX)([._@].*)?$/i.test(value)) continue;
    return /^zh([_.@-]|$)/i.test(value) ? "zh" : "en";
  }
  let locale = "";
  try {
    locale = intlLocale() || "";
  } catch (_err) {
    // no Intl: English
  }
  return /^zh([_-]|$)/i.test(locale) ? "zh" : "en";
}

/**
 * minNode reads the lowest Node.js version a range of the form ">=x.y.z"
 * allows; any other form gives undefined.
 * @param {string | undefined} range
 */
export function minNode(range) {
  const m = /^\s*>=\s*v?(\d+)\.(\d+)\.(\d+)\s*$/.exec(range || "");
  return m ? `${m[1]}.${m[2]}.${m[3]}` : undefined;
}

/**
 * olderThan says whether version a comes before version b (both x.y.z).
 * @param {string} a @param {string} b
 */
export function olderThan(a, b) {
  const pa = a.replace(/^v/, "").split(/[.-]/).map(Number);
  const pb = b.replace(/^v/, "").split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * parse reads the command line.
 * @param {string[]} argv the arguments after the command's name
 * @returns {{ kind: "help" | "version" } | { kind: "deploy", name?: string, dryRun: boolean } | { kind: "error", text: "unknown" | "noName", arg: string }}
 */
export function parse(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h") || (argv.length === 1 && argv[0] === "help")) {
    return { kind: "help" };
  }
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) return { kind: "version" };
  if (argv[0] !== "deploy") return { kind: "error", text: "unknown", arg: argv[0] };
  /** @type {{ kind: "deploy", name?: string, dryRun: boolean }} */
  const cmd = { kind: "deploy", dryRun: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      cmd.dryRun = true;
    } else if (a === "--name" || a.startsWith("--name=")) {
      const value = a === "--name" ? argv[++i] : a.slice("--name=".length);
      if (value === undefined || value === "" || value.startsWith("-")) return { kind: "error", text: "noName", arg: a };
      cmd.name = value;
    } else {
      return { kind: "error", text: "unknown", arg: a };
    }
  }
  return cmd;
}

/**
 * address finds the https address of the deployment in what wrangler wrote
 * to its output file: one JSON object a line, the deploy entry's targets.
 * @param {string | undefined} text
 */
export function address(text) {
  if (!text) return undefined;
  let found;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_err) {
      continue;
    }
    if (!entry || entry.type !== "deploy" || !Array.isArray(entry.targets)) continue;
    const https = entry.targets.filter((/** @type {unknown} */ t) => typeof t === "string" && /^https:\/\/\S+$/.test(t));
    if (https.length > 0) found = https[0];
  }
  return found;
}

/**
 * @typedef {{ on(event: "exit", f: (code: number | null, signal: string | null) => void): unknown, on(event: "error", f: (err: Error) => void): unknown }} Child
 * @typedef {{
 *   argv: string[],
 *   env: Record<string, string | undefined>,
 *   nodeVersion: string,
 *   execPath: string,
 *   packageDir: string,
 *   version: string,
 *   nodeRange: string | undefined,
 *   wrangler: () => string,
 *   spawn: (command: string, args: string[], options: { cwd: string, env: Record<string, string | undefined>, stdio: "inherit" }) => Child,
 *   out: (text: string) => void,
 *   err: (text: string) => void,
 *   readFile: (file: string) => string | undefined,
 *   removeFile: (file: string) => void,
 *   intlLocale: () => string,
 *   token: () => string,
 * }} Io
 */

const signals = /** @type {Record<string, number>} */ ({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 });

/**
 * run carries out the command line in io.argv and gives the exit code.
 * @param {Io} io
 * @returns {Promise<number>}
 */
export async function run(io) {
  const t = texts[language(io.env, io.intlLocale)];
  const cmd = parse(io.argv);
  if (cmd.kind === "help") {
    io.out(help);
    return 0;
  }
  if (cmd.kind === "version") {
    io.out(`${io.version}\n`);
    return 0;
  }
  if (cmd.kind === "error") {
    io.err(`${t[cmd.text]({ arg: cmd.arg })}\n\n${help}`);
    return 2;
  }

  const needed = minNode(io.nodeRange);
  if (needed && olderThan(io.nodeVersion, needed)) {
    io.err(`${t.oldNode({ needed, found: io.nodeVersion })}\n`);
    return 1;
  }

  const args = [io.wrangler(), "deploy", "--config", path.join(io.packageDir, "wrangler.jsonc")];
  if (cmd.name !== undefined) args.push("--name", cmd.name);
  if (cmd.dryRun) args.push("--dry-run");

  /** @type {Record<string, string | undefined>} */
  const env = Object.assign({}, io.env);
  if (env.WRANGLER_SEND_METRICS === undefined) env.WRANGLER_SEND_METRICS = "false";
  // Wrangler can write what it deployed, the address among it, to a file. It
  // goes in the package's own .wrangler directory, and only when the person
  // has not asked wrangler for such a file themselves.
  let outputFile;
  if (!cmd.dryRun && env.WRANGLER_OUTPUT_FILE_PATH === undefined && env.WRANGLER_OUTPUT_FILE_DIRECTORY === undefined) {
    outputFile = path.join(io.packageDir, ".wrangler", `ziwo-deploy-${io.token()}.json`);
    env.WRANGLER_OUTPUT_FILE_PATH = outputFile;
  }

  /** @type {number} */
  const code = await new Promise((resolve) => {
    let child;
    try {
      child = io.spawn(io.execPath, args, { cwd: io.packageDir, env, stdio: "inherit" });
    } catch (_err) {
      resolve(1);
      return;
    }
    child.on("error", () => resolve(1));
    child.on("exit", (status, signal) => {
      if (typeof status === "number") resolve(status);
      else resolve(signal && signals[signal] ? 128 + signals[signal] : 1);
    });
  });

  let written;
  if (outputFile) {
    written = io.readFile(outputFile);
    io.removeFile(outputFile);
  }
  if (code !== 0) {
    io.err(`\n${t.failed({})}\n`);
    return code;
  }
  if (cmd.dryRun) {
    io.out(`\n${t.dryRun({})}\n`);
    return 0;
  }
  const at = address(written);
  const first = at ? t.deployedAt({ address: at }) : t.deployedSomewhere({});
  // The command that updates this deployment: under another name, with it,
  // or the plain command would make a second deployment beside this one.
  const command = `${npx} deploy${cmd.name !== undefined ? ` --name ${cmd.name}` : ""}`;
  io.out(`\n${first}\n\n${t.next({ command })}\n`);
  return 0;
}

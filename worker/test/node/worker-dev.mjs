// The Worker under `wrangler dev --local`, for tests that need it running:
// a free port, a random admin secret given with --var, its state in a
// scratch directory, and a process group that is stopped at the end. It
// never contacts a Cloudflare account.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { workerDir } from "./go.mjs";

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = /** @type {net.AddressInfo} */ (s.address()).port;
      s.close(() => resolve(port));
    });
  });
}

/**
 * startWorker starts wrangler dev with its state under dir and waits until
 * the page answers.
 * @param {string} dir
 */
export async function startWorker(dir) {
  const [port, inspector] = await Promise.all([freePort(), freePort()]);
  const secret = `test-${randomBytes(12).toString("hex")}`;
  const log = path.join(dir, "wrangler.log");
  const fd = openSync(log, "w");
  const proc = spawn(
    "npx",
    // The configuration without the AI binding: no test reaches an account.
    ["wrangler", "dev", "--config", "wrangler.dev.jsonc", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector),
      "--persist-to", path.join(dir, "state"), "--var", `ADMIN_SECRET:${secret}`],
    {
      cwd: workerDir,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: {
        ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: path.join(dir, "wrangler-logs"),
        WRANGLER_REGISTRY_PATH: path.join(dir, "registry"), NO_UPDATE_NOTIFIER: "1", CI: "1",
      },
    },
  );
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (proc.exitCode !== null || proc.pid === undefined) return;
    const exited = new Promise((resolve) => proc.once("exit", resolve));
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      return;
    }
    const late = setTimeout(() => {
      try {
        process.kill(-(/** @type {number} */ (proc.pid)), "SIGKILL");
      } catch {
        // gone
      }
    }, 15_000);
    await exited;
    clearTimeout(late);
  };
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    try {
      const res = await fetch(`${base}/`);
      await res.arrayBuffer();
      return { base, secret, stop };
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  await stop();
  throw new Error(`the Worker did not start:\n${(await readFile(log, "utf8")).slice(-2000)}`);
}

const modern = "2026-07-28";

/**
 * tool calls an MCP tool on a memory, as Claude Code does (the new protocol
 * generation), and returns the status and the tool's text.
 * @param {string} base @param {string} memory @param {string} token @param {string} name @param {Record<string, unknown>} args
 */
export async function tool(base, memory, token, name, args) {
  const res = await fetch(`${base}/${memory}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`,
      "mcp-protocol-version": modern, "mcp-method": "tools/call", "mcp-name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name, arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": modern,
          "io.modelcontextprotocol/clientInfo": { name: "ziwo-admin-test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const raw = await res.text();
  if (res.status !== 200) return { status: res.status, text: "" };
  const line = raw.split("\n").map((l) => l.replace(/^data: /, "")).find((l) => l.startsWith("{")) ?? "{}";
  const msg = JSON.parse(line);
  const text = (msg.result?.content ?? []).map((/** @type {{ text?: string }} */ c) => c.text ?? "").join("");
  return { status: res.status, text: msg.result?.isError ? `ERROR: ${text}` : text };
}

/**
 * approveClient registers an OAuth client and approves it on the consent
 * page with the memory's token, as a browser would, leaving a grant whose
 * code is never exchanged.
 * @param {string} base @param {string} memory @param {string} token @param {string} clientName
 */
export async function approveClient(base, memory, token, clientName) {
  const redirect = "https://client.example/callback";
  const reg = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
  });
  if (reg.status !== 201) throw new Error(`register: ${reg.status}`);
  const { client_id: clientId } = await reg.json();
  const challenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirect, state: "s", code_challenge: challenge, code_challenge_method: "S256",
    resource: `${base}/${memory}/mcp`,
  });
  const page = await fetch(`${base}/oauth/authorize?${q}`);
  const html = await page.text();
  if (page.status !== 200) throw new Error(`consent page: ${page.status}`);
  const cookie = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  /** @type {Record<string, string>} */
  const fields = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[m[1]] = m[2].replace(/&#(\d+);/g, (_w, c) => String.fromCharCode(Number(c)));
  }
  const res = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base, cookie },
    body: new URLSearchParams({ ...fields, decision: "approve", credential: token }).toString(),
    redirect: "manual",
  });
  await res.arrayBuffer();
  if (res.status !== 302) throw new Error(`approve: ${res.status}`);
}

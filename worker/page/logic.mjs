// What the admin page and the admin script share, kept apart from the
// document so that it runs in Node as well: the calls to the admin API, the
// forgetting parameters, and the small decisions the page makes. Nothing
// here touches the DOM, storage or the network beyond the fetch it is given.

// The forgetting parameters in the order the API lists them, with the
// defaults of the Go build.
export const paramNames = ["baseStrength", "recallBoost", "fadeBelow", "archiveBelow", "coreImportance", "coreFeeling"];

export const defaultParams = {
  baseStrength: 100,
  recallBoost: 2,
  fadeBelow: 0.3,
  archiveBelow: 0.05,
  coreImportance: 0.9,
  coreFeeling: 0.9,
};

// The levels of the check's findings, most serious first.
export const levels = ["problem", "warning", "note"];

// ApiError is an answer of the admin API other than a success. Its message
// is the API's own words, with the status in front.
export class ApiError extends Error {
  /** @param {number} status @param {string} text */
  constructor(status, text) {
    super(`HTTP ${status}: ${text}`);
    this.name = "ApiError";
    this.status = status;
    this.text = text;
  }
}

/**
 * errorText reads what an answer that is not a success says: the error of a
 * JSON body, or the text of a plain one, or the status line when empty.
 * @param {Response} res
 */
export async function errorText(res) {
  const raw = (await res.text()).trim();
  try {
    const v = JSON.parse(raw);
    if (v !== null && typeof v === "object" && typeof v.error === "string") return v.error;
  } catch {
    // not JSON: the text as it came
  }
  return raw !== "" ? raw : res.statusText || "no answer";
}

/** @param {string} name @param {string} [route] */
export function memoryPath(name, route = "") {
  return `/admin/memories/${encodeURIComponent(name)}${route === "" ? "" : `/${route}`}`;
}

// SecretError says the admin secret cannot be sent, without saying it: a
// fetch refusing a header value would put the value in its message.
export class SecretError extends Error {
  constructor() {
    super("the admin secret holds a character that cannot be sent in a header");
    this.name = "SecretError";
  }
}

/**
 * makeApi returns the calls of the admin API. base is the deployment's
 * address ("" in the page: the same origin); the secret goes only into the
 * Authorization header of each call.
 * @param {{ base?: string, secret: string, fetch?: typeof fetch }} opts
 */
export function makeApi({ base = "", secret, fetch: doFetch = globalThis.fetch.bind(globalThis) }) {
  const sendable = /^[\x20-\x7e]+$/.test(secret) && secret.trim() !== "";
  /** @param {string} method @param {string} path @param {{ body?: BodyInit, type?: string, accept?: string }} [o] */
  async function send(method, path, o = {}) {
    if (!sendable) throw new SecretError();
    /** @type {Record<string, string>} */
    const headers = { authorization: `Bearer ${secret}`, accept: o.accept ?? "application/json" };
    if (o.type !== undefined) headers["content-type"] = o.type;
    const res = await doFetch(base + path, { method, headers, body: o.body });
    if (!res.ok) throw new ApiError(res.status, await errorText(res));
    return res;
  }
  /** @param {string} method @param {string} path @param {{ body?: BodyInit, type?: string }} [o] */
  const call = async (method, path, o) => (await send(method, path, o)).json();
  return {
    list: () => call("GET", "/admin/memories"),
    describe: (/** @type {string} */ name) => call("GET", memoryPath(name)),
    create: (/** @type {string} */ name) => call("POST", memoryPath(name)),
    newToken: (/** @type {string} */ name) => call("POST", memoryPath(name, "token")),
    /** @param {string} name @param {{ params?: Record<string, number>, timeZone?: string }} change */
    settings: (name, change) =>
      call("PUT", memoryPath(name, "settings"), { body: JSON.stringify(change), type: "application/json" }),
    check: (/** @type {string} */ name) => call("GET", memoryPath(name, "check")),
    rebuild: (/** @type {string} */ name) => call("POST", memoryPath(name, "rebuild")),
    // The export in the clear, as bytes, with the name the API gives it.
    // The caller seals it and lets go of it.
    exportClear: async (/** @type {string} */ name) => {
      const res = await send("GET", memoryPath(name, "export"), { accept: "application/x-ndjson" });
      return { bytes: new Uint8Array(await res.arrayBuffer()), disposition: res.headers.get("content-disposition") ?? "" };
    },
    /** @param {string} name @param {Uint8Array} bytes */
    importClear: (name, bytes) => call("POST", memoryPath(name, "import"), { body: bytes, type: "application/x-ndjson" }),
    // The clients granted access through OAuth, and revoking one.
    grants: (/** @type {string} */ name) => call("GET", memoryPath(name, "grants")),
    /** @param {string} name @param {string} id */
    revokeGrant: (name, id) => call("DELETE", memoryPath(name, `grants/${encodeURIComponent(id)}`)),
    // Deleting a memory for good: the API wants its name repeated, as the
    // person typed it.
    /** @param {string} name @param {string} typed */
    deleteMemory: (name, typed) => call("DELETE", memoryPath(name) + `?confirm=${encodeURIComponent(typed)}`),
  };
}

/**
 * namesMatch says whether what the person typed to confirm a deletion is the
 * memory's name: exactly, but for spaces around it.
 * @param {string} typed @param {string} name
 */
export function namesMatch(typed, name) {
  return typed.trim() === name;
}

/**
 * sealedFileName names a sealed export as Go's export does,
 * <name>-<date>.ziwo-export, taking the date from the name the API gave the
 * export in the clear.
 * @param {string} disposition the content-disposition of the export
 * @param {string} name
 * @param {number} now unix milliseconds, used when the API gave no name
 */
export function sealedFileName(disposition, name, now) {
  const m = /filename="([a-z0-9_-]+-\d{8}-\d{6})\.ndjson"/.exec(disposition);
  if (m !== null) return `${m[1]}.ziwo-export`;
  const stamp = new Date(now).toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "").replace("T", "-");
  return `${name}-${stamp}.ziwo-export`;
}

/**
 * settingsChange compares what the form holds with the settings in force and
 * returns the change to send: only what differs. A value that is not a
 * number is named instead.
 * @param {{ params: Record<string, number>, timeZone: string }} current
 * @param {{ params: Record<string, string>, timeZone: string }} form
 * @returns {{ change: { params?: Record<string, number>, timeZone?: string }, replays: boolean } | { notANumber: string } | { unchanged: true }}
 */
export function settingsChange(current, form) {
  /** @type {Record<string, number>} */
  const params = {};
  for (const p of paramNames) {
    const raw = (form.params[p] ?? "").trim();
    const n = raw === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(n)) return { notANumber: p };
    if (!Object.is(n, current.params[p])) params[p] = n;
  }
  /** @type {{ params?: Record<string, number>, timeZone?: string }} */
  const change = {};
  const replays = Object.keys(params).length > 0;
  if (replays) change.params = params;
  const zone = form.timeZone.trim();
  if (zone !== current.timeZone) change.timeZone = zone;
  if (change.params === undefined && change.timeZone === undefined) return { unchanged: true };
  return { change, replays };
}

/**
 * reportGroups lays the findings of a check out by level, most serious
 * first; a level the page does not know comes last, as given.
 * @param {{ findings: { level: string, code: string, text: string, ids: string[] }[] }} report
 */
export function reportGroups(report) {
  const known = levels.map((level) => ({ level, findings: report.findings.filter((f) => f.level === level) }));
  const other = [...new Set(report.findings.map((f) => f.level).filter((l) => !levels.includes(l)))];
  return [...known, ...other.map((level) => ({ level, findings: report.findings.filter((f) => f.level === level) }))];
}

/**
 * reportText lays a check report out as the check tool does, word for word.
 * @param {{ figures: { name: string, value: string }[], findings: { level: string, code: string, text: string, ids: string[] }[] }} report
 */
export function reportText(report) {
  let b = "";
  for (const f of report.figures) b += `${f.name}: ${f.value}\n`;
  for (const level of levels) {
    const found = report.findings.filter((f) => f.level === level);
    b += `${level}s: ${found.length === 0 ? "none" : ""}\n`;
    for (const f of found) b += `  [${f.code}] ${f.text}${f.ids.length > 0 ? `: ${f.ids.join(", ")}` : ""}\n`;
  }
  return b;
}

/**
 * route reads the part of the page's address after #: the list, or one
 * memory. Nothing secret is ever put there.
 * @param {string} hash
 * @returns {{ view: "list" } | { view: "memory", name: string }}
 */
export function route(hash) {
  const m = /^#\/memory\/([^/]+)$/.exec(hash);
  if (m === null) return { view: "list" };
  try {
    return { view: "memory", name: decodeURIComponent(m[1]) };
  } catch {
    return { view: "list" };
  }
}

/** @param {string} name */
export function memoryHash(name) {
  return `#/memory/${encodeURIComponent(name)}`;
}

/**
 * pickLanguage chooses Simplified Chinese or English from the browser's
 * languages, in the browser's order; English when neither is listed.
 * @param {readonly string[]} languages
 * @returns {"en" | "zh"}
 */
export function pickLanguage(languages) {
  for (const l of languages) {
    const tag = l.toLowerCase();
    if (tag === "zh" || tag.startsWith("zh-")) return "zh";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return "en";
}

/**
 * utcStamp writes a time as Go's list does: 2026-11-11 08:00Z.
 * @param {number} ms
 */
export function utcStamp(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

// The fewest characters an admin secret may have to count. It mirrors
// minAdminSecret in src/admin.ts; a test keeps the two equal.
export const minAdminSecret = 16;

// The longest admin secret the page may set. It mirrors maxAdminSecret in
// src/admin.ts; a test keeps the two equal.
export const maxAdminSecret = 200;

/**
 * adminState asks the deployment, without presenting a credential, what its
 * admin secret is (GET /admin/setup): "ready" when one is set, of either
 * kind; "open" when one may be set on this page, with until, the time that
 * closes (unix milliseconds); "closed" when it has to be set in the
 * Cloudflare dashboard. Anything unexpected is "unknown". A request without
 * a credential is not weighed against the limit on guessing.
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ state: "ready" | "closed" | "unknown" } | { state: "open", until: number }>}
 */
export async function adminState(fetchFn = globalThis.fetch.bind(globalThis)) {
  try {
    const res = await fetchFn("/admin/setup", { method: "GET", headers: { accept: "application/json" } });
    if (res.status !== 200) return { state: "unknown" };
    const v = await res.json();
    if (v === null || typeof v !== "object") return { state: "unknown" };
    if (v.state === "set") return { state: "ready" };
    if (v.state === "closed") return { state: "closed" };
    if (v.state === "open" && typeof v.until === "number" && Number.isFinite(v.until)) return { state: "open", until: v.until };
    return { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

/**
 * newSecretProblem says why a secret cannot be set on the page, or
 * undefined: "short" under minAdminSecret characters, "unsendable" when a
 * character is not printable ASCII or is a space. The server holds the same
 * rule (src/admin.ts, newSecretProblem), and every secret it lets through is
 * one makeApi can send. The field takes at most maxAdminSecret characters.
 * @param {string} secret
 * @returns {"short" | "unsendable" | undefined}
 */
export function newSecretProblem(secret) {
  if ([...secret].length < minAdminSecret) return "short";
  if (!/^[\x21-\x7e]+$/.test(secret)) return "unsendable";
  return undefined;
}

/**
 * setAdminSecret sets the admin secret on the page (POST /admin/setup):
 * "set" when it took (201), "taken" when one is set already (409), "closed"
 * when it can no longer be set here (403 saying so). Any other answer is an
 * ApiError. The secret goes
 * only into the body of this one request.
 * @param {string} secret
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<"set" | "taken" | "closed">}
 */
export async function setAdminSecret(secret, fetchFn = globalThis.fetch.bind(globalThis)) {
  const res = await fetchFn("/admin/setup", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ secret }),
  });
  if (res.status === 201) return "set";
  if (res.status === 409) return "taken";
  // A 403 says closed in its body; a refused cross-site post does not.
  const text = await res.text();
  if (res.status === 403) {
    try {
      if (JSON.parse(text).state === "closed") return "closed";
    } catch {
      // not the closed answer
    }
  }
  throw new ApiError(res.status, await errorText(new Response(text, { status: res.status, statusText: res.statusText })));
}

// The length of a generated admin secret.
export const generatedSecretLength = 24;

const secretAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * makeSecret draws generatedSecretLength characters from A-Z a-z 0-9, each
 * equally likely: bytes from 248 up (248 = 62 * 4) are discarded, and more
 * bytes are asked for until enough characters are drawn.
 * @param {(n: number) => Uint8Array} [random]
 */
export function makeSecret(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  let out = "";
  while (out.length < generatedSecretLength) {
    for (const b of random(generatedSecretLength - out.length + 8)) {
      if (b >= 248 || out.length === generatedSecretLength) continue;
      out += secretAlphabet[b % 62];
    }
  }
  return out;
}

/**
 * workerNameOf reads a Worker's name from its workers.dev address
 * (name.account.workers.dev); a custom domain gives "".
 * @param {string} hostname
 */
export function workerNameOf(hostname) {
  const labels = hostname.split(".");
  return hostname.endsWith(".workers.dev") && labels.length >= 3 ? labels[0] : "";
}

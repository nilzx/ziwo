// The consent page, at the authorization endpoint. It is served by the Worker
// as plain HTML in the look of the admin page, with no script: it names the
// client that asks, where it sends the person back and the memory it asks
// for, and asks for one thing, the memory's token or the admin secret. Either
// approves a grant for that memory alone; anything else gets one message.
//
// Against forged and framed requests: the page cannot be framed (CSP
// frame-ancestors, X-Frame-Options); a post must come from this origin
// (Origin, or Sec-Fetch-Site where Origin is withheld); and the library binds
// each page's one-time handle to the browser that opened it with a __Host-
// cookie, keeping the request itself server-side, so the form carries no
// part of it that is trusted.

import {
  type AuthRequest,
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import type { Note } from "./admin";
import { consentTexts, type Lang, pickLang, type TextKey } from "./consent-texts";
import { waitFor } from "./guard";
import { encoder, plain, sha256Hex, validName } from "./http";
import type { Env } from "./index";
import { clipText } from "./log";
import { authServer, type GrantMetadata, type GrantProps, memoryOfResource, paths, resourceOf, word } from "./oauth";

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// t gives a text as HTML; vars are HTML already, built from escaped values.
function t(lang: Lang, key: TextKey, vars: Record<string, string> = {}): string {
  return esc(consentTexts[lang][key]).replace(/\{([a-zA-Z]+)\}/g, (whole, k: string) => vars[k] ?? whole);
}

const strong = (s: string): string => `<strong>${esc(s)}</strong>`;

// The policy of every page here: no script at all, the admin page's style
// sheet, forms that post only here and, after an approval, to the client's
// redirect URI (Chrome holds a form's redirect to form-action as well).
export function consentPolicy(formTargets: readonly string[] = []): string {
  return [
    "default-src 'none'",
    "style-src 'self'",
    "img-src 'self'",
    ["form-action 'self'", ...formTargets].join(" "),
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "require-trusted-types-for 'script'",
  ].join("; ");
}

function securityHeaders(formTargets: readonly string[] = []): Headers {
  return new Headers({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": consentPolicy(formTargets),
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    // same-origin, not no-referrer: under no-referrer a browser sends
    // "Origin: null" with the page's own post, and the check below needs it.
    "referrer-policy": "same-origin",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "cache-control": "no-store",
  });
}

// The origin the client's redirect URI is on, for form-action; nothing for a
// URI without one.
function redirectOrigin(uri: string): string[] {
  try {
    const o = new URL(uri).origin;
    return /^https?:\/\/[^\s;,']+$/.test(o) ? [o] : [];
  } catch {
    return [];
  }
}

function document(lang: Lang, toggle: string | undefined, body: string): string {
  const other: Lang = lang === "zh" ? "en" : "zh";
  const link = toggle === undefined ? "" : `<a href="${esc(toggle)}" lang="${other === "zh" ? "zh-CN" : "en"}">${esc(consentTexts[other].languageName)}</a>`;
  return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${t(lang, "title")}</title>
<link rel="stylesheet" href="/_page/style.css">
</head>
<body>
<header class="bar">
<span class="brand">ziwo</span>
<span class="tools">${link}</span>
</header>
<main id="main">
${body}
</main>
</body>
</html>
`;
}

// toggleFor is the same request in the other language.
function toggleFor(query: URLSearchParams, lang: Lang): string {
  const q = new URLSearchParams(query);
  q.set("hl", lang === "zh" ? "en" : "zh");
  return `${paths.authorize}?${q}`;
}

function htmlResponse(status: number, html: string, headers: Headers): Response {
  return new Response(html, { status, headers });
}

function messagePage(status: number, lang: Lang, key: TextKey, vars: Record<string, string> = {}, detail?: string): Response {
  const more = detail === undefined ? "" : `\n<p class="hint">${t(lang, "detail", { detail: esc(detail) })}</p>`;
  const body = `<h2>${t(lang, "title")}</h2>\n<p class="out error" role="alert">${t(lang, key, vars)}</p>${more}`;
  return htmlResponse(status, document(lang, undefined, body), securityHeaders());
}

function redirect(location: string, headers = new Headers()): Response {
  headers.set("location", location);
  headers.set("cache-control", "no-store");
  return new Response(null, { status: 302, headers });
}

// failure answers what the library refused: back to the client when the
// library says that is safe, else here. Anything else is a fault, thrown.
function failure(err: unknown, lang: Lang, note: Note, stage: "parse" | "consume"): Response {
  if (err instanceof AuthorizationError) {
    note.outcome = word(err.code);
    if (err.redirectTo !== undefined) return redirect(err.redirectTo);
    return stage === "consume" ? messagePage(400, lang, "expired") : messagePage(400, lang, "invalid", {}, err.description);
  }
  if (err instanceof CimdFetchError) {
    note.outcome = "client_metadata_failed";
    return messagePage(400, lang, "cimd", { url: esc(err.metadataUrl) });
  }
  throw err;
}

function clientFacts(lang: Lang, d: ConsentDescription): string {
  const who = d.clientDomain !== undefined ? t(lang, "clientPublished", { domain: strong(d.clientDomain) }) : t(lang, "clientSelfNamed");
  return `<dl class="figures">
<dt>${t(lang, "clientLabel")}</dt><dd>${strong(clipText(d.clientName, 200))}<br><span class="hint">${who}</span></dd>
<dt>${t(lang, "returnLabel")}</dt><dd>${strong(d.redirectHost)}<br><code>${esc(d.redirectUri)}</code></dd>
</dl>${d.redirectIsLoopback ? `\n<p class="warn">${t(lang, "loopbackWarn")}</p>` : ""}`;
}

const hidden = (name: string, value: string): string => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;

// askName is the page for a request that names no memory: a form that asks
// the same request again, with the memory's name added.
function askName(lang: Lang, query: URLSearchParams, d: ConsentDescription, badName: boolean): Response {
  const kept = [...query.entries()].filter(([k]) => k !== "memory" && k !== "hl").map(([k, v]) => hidden(k, v));
  const body = `<h2 tabindex="-1">${t(lang, "askTitle")}</h2>
<p>${t(lang, "askIntro", { client: strong(clipText(d.clientName, 200)) })}</p>
${clientFacts(lang, d)}
<form method="get" action="${paths.authorize}">
${kept.join("\n")}
${hidden("hl", lang)}
<div class="field">
<label for="memory">${t(lang, "askLabel")}</label>
<p class="hint" id="memory-hint">${t(lang, "askHint")}</p>
<input id="memory" name="memory" required autofocus autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="memory-hint" value="${esc(query.get("memory") ?? "")}">
</div>
${badName ? `<p class="out error" role="alert">${t(lang, "askBadName")}</p>\n` : ""}<p><button type="submit">${t(lang, "continue")}</button></p>
</form>`;
  return htmlResponse(badName ? 400 : 200, document(lang, toggleFor(query, lang), body), securityHeaders());
}

function consentBody(lang: Lang, d: ConsentDescription, memory: string, resource: string, handle: string, query: URLSearchParams, refused: boolean): string {
  return `<h2 tabindex="-1">${t(lang, "heading", { client: strong(clipText(d.clientName, 200)), memory: strong(memory) })}</h2>
${refused ? `<p class="out error" role="alert">${t(lang, "refused")}</p>\n` : ""}${clientFacts(lang, d)}
<dl class="figures">
<dt>${t(lang, "memoryLabel")}</dt><dd>${strong(memory)}</dd>
<dt>${t(lang, "addressLabel")}</dt><dd><code>${esc(resource)}</code></dd>
</dl>
<p>${t(lang, "what")}</p>
<form method="post" action="${paths.authorize}">
${hidden("handle", handle)}
${hidden("memory", memory)}
${hidden("q", query.toString())}
${hidden("hl", lang)}
<div class="field">
<label for="credential">${t(lang, "credLabel")}</label>
<p class="hint" id="credential-hint">${t(lang, "credHint")}</p>
<input id="credential" name="credential" type="password" required autofocus autocomplete="off" spellcheck="false" aria-describedby="credential-hint">
</div>
<p class="actions"><button type="submit" name="decision" value="approve" class="primary">${t(lang, "approve")}</button>
<button type="submit" name="decision" value="deny" formnovalidate>${t(lang, "deny")}</button></p>
</form>`;
}

// authorizePage answers an authorization request: the page that asks for the
// memory's name, or the consent page. refused shows it again after a
// credential was not accepted.
async function authorizePage(env: Env, issuer: string, url: URL, lang: Lang, note: Note, refused: boolean): Promise<Response> {
  const query = url.searchParams;
  const resources = query.getAll("resource");
  let name: string | undefined;
  let badName = false;
  if (resources.length === 1) {
    name = memoryOfResource(issuer, resources[0]!);
  } else if (resources.length === 0 && query.has("memory")) {
    const m = query.get("memory")!.trim();
    if (validName(m)) name = m;
    else badName = true;
  }
  // A resource that names none of the memories is the library's to refuse:
  // against the placeholder, it fails as invalid_target.
  const oauth = authServer(issuer, name === undefined ? [] : [name]).getOAuthApi(env);
  let req: AuthRequest;
  let details: ConsentDescription;
  try {
    req = await oauth.parseAuthRequest(new Request(url.toString()));
    // PKCE for every client, confidential ones too: every MCP client sends it.
    if (req.codeChallenge === undefined) {
      note.outcome = "pkce_required";
      return redirect(authorizationErrorRedirect(req, "invalid_request", "PKCE with S256 is required"));
    }
    details = await oauth.describeConsent(req);
  } catch (err) {
    return failure(err, lang, note, "parse");
  }
  if (name === undefined) {
    note.outcome = badName ? "bad_name" : "asked_name";
    return askName(lang, query, details, badName);
  }
  note.memory = name;
  const consent = await oauth.beginConsent(req);
  const headers = securityHeaders(redirectOrigin(req.redirectUri));
  for (const c of consent.headers.getSetCookie()) headers.append("set-cookie", c);
  note.outcome = refused ? "refused" : "shown";
  const body = consentBody(lang, details, name, resourceOf(issuer, name), consent.handle, query, refused);
  return htmlResponse(refused ? 403 : 200, document(lang, toggleFor(query, lang), body), headers);
}

// sameOrigin says whether a post was sent from a page of this origin.
function sameOrigin(request: Request, issuer: string): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "null") return origin === issuer;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

const maxForm = 16 * 1024;

async function readForm(request: Request): Promise<URLSearchParams | undefined> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return undefined;
  // As bytes: the runtime warns when a form body is read as text.
  const bytes = await request.arrayBuffer();
  return bytes.byteLength > maxForm ? undefined : new URLSearchParams(new TextDecoder().decode(bytes));
}

// weigh says which credential approves a grant for memory: the memory's own
// token, or the admin secret for a memory that exists; and the memory's
// instance, which the grant records. The memory's object is asked the same
// whatever was typed, so the answer takes as long either way.
async function weigh(env: Env, memory: string, typed: string): Promise<{ via?: "token" | "admin"; instance: string }> {
  const credential = typed.trim();
  const hash = await sha256Hex(credential);
  const stub = env.MEMORY.getByName(memory);
  const [access, instance] = await Promise.all([stub.authorize(hash), stub.instance()]);
  if (access === "ok") return { via: "token", instance };
  const secret = env.ADMIN_SECRET;
  if (secret === undefined || secret === "" || credential === "") return { instance };
  const same = crypto.subtle.timingSafeEqual(encoder.encode(hash), encoder.encode(await sha256Hex(secret)));
  return same && access !== "unknown" ? { via: "admin", instance } : { instance };
}

// decide answers the consent form.
async function decide(request: Request, env: Env, issuer: string, note: Note): Promise<Response> {
  const fallback = pickLang(null, request.headers.get("accept-language"));
  if (!sameOrigin(request, issuer)) {
    note.outcome = "forged";
    return messagePage(403, fallback, "forged");
  }
  const form = await readForm(request);
  const memory = form?.get("memory") ?? "";
  const lang = pickLang(form?.get("hl") ?? null, request.headers.get("accept-language"));
  if (form === undefined || !validName(memory)) {
    note.outcome = "invalid_request";
    return messagePage(400, lang, "invalid");
  }
  note.memory = memory;
  const oauth = authServer(issuer, [memory]).getOAuthApi(env);
  const handle = form.get("handle") ?? "";

  if (form.get("decision") === "deny") {
    try {
      const denied = await oauth.denyConsent(request, handle);
      note.outcome = "denied";
      return new Response(null, { status: 302, headers: denied.headers });
    } catch (err) {
      return failure(err, lang, note, "consume");
    }
  }

  let via: "token" | "admin" | undefined;
  let instance: string;
  try {
    ({ via, instance } = await weigh(env, memory, form.get("credential") ?? ""));
  } catch {
    note.outcome = "unavailable";
    return messagePage(503, lang, "unavailable");
  }
  // The limit on guessing (guard.ts). The handle is left unused, so the
  // person can go back to the form once the wait is over; nothing here
  // writes to KV, however often it is asked.
  const wait = await waitFor(env, request, via !== undefined);
  if (wait > 0) {
    note.outcome = "too_many";
    const res = messagePage(429, lang, "tooMany", { seconds: String(wait) });
    res.headers.set("retry-after", String(wait));
    return res;
  }
  if (via === undefined || instance === "unknown") {
    // The handle is left unused; a fresh page is made from the request.
    return authorizePage(env, issuer, new URL(`${issuer}${paths.authorize}?${form.get("q") ?? ""}`), lang, note, true);
  }

  try {
    const approved = await oauth.approveConsent(request, handle);
    // The request comes from storage, not from the form; the memory the
    // credential was weighed for must be the one it asks for.
    if (approved.request.resource !== resourceOf(issuer, memory)) {
      note.outcome = "invalid_target";
      return messagePage(400, lang, "invalid");
    }
    const client = clipText((await oauth.describeConsent(approved.request)).clientName, 120);
    const metadata: GrantMetadata = { client, via };
    const props: GrantProps = { memory, client, instance };
    const { redirectTo } = await oauth.completeAuthorization({ request: approved.request, userId: memory, metadata, scope: [], props });
    note.outcome = "approved";
    note.cred = via;
    return redirect(redirectTo, approved.headers);
  } catch (err) {
    return failure(err, lang, note, "consume");
  }
}

// serveAuthorize answers the authorization endpoint.
export async function serveAuthorize(request: Request, env: Env, issuer: string, note: Note): Promise<Response> {
  if (request.method === "GET") {
    const url = new URL(request.url);
    return authorizePage(env, issuer, url, pickLang(url.searchParams.get("hl"), request.headers.get("accept-language")), note, false);
  }
  if (request.method === "POST") return decide(request, env, issuer, note);
  return plain(405, "Method Not Allowed", { allow: "GET, POST" });
}

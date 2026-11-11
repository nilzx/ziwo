// The admin page: one static document at / and the files it loads under
// /_page/. Wrangler bundles the files of page/ as text (the rule in
// wrangler.jsonc), so the Worker only hands their bytes out: it never runs
// the page's code, and in particular never seals, opens or derives a key.
// Serving them reaches no Durable Object.

import app from "../page/app.mjs";
import connect from "../page/connect.mjs";
import dom from "../page/dom.mjs";
import html from "../page/index.html";
import logic from "../page/logic.mjs";
import seal from "../page/seal.mjs";
import style from "../page/style.css";
import texts from "../page/texts.mjs";
import { notFound } from "./http";

const js = "text/javascript; charset=utf-8";

const files = new Map<string, [body: string, type: string]>([
  ["/", [html, "text/html; charset=utf-8"]],
  ["/_page/style.css", [style, "text/css; charset=utf-8"]],
  ["/_page/app.mjs", [app, js]],
  ["/_page/connect.mjs", [connect, js]],
  ["/_page/dom.mjs", [dom, js]],
  ["/_page/logic.mjs", [logic, js]],
  ["/_page/seal.mjs", [seal, js]],
  ["/_page/texts.mjs", [texts, js]],
]);

// The page loads nothing from another origin and is framed by no one; its
// scripts and styles are files of its own, never inline, and nothing it
// builds is parsed as HTML.
export const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "require-trusted-types-for 'script'",
].join("; ");

export const pageHeaders: Record<string, string> = {
  "content-security-policy": contentSecurityPolicy,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-cache",
};

export function isPagePath(path: string): boolean {
  return path === "/" || path.startsWith("/_page/");
}

// Other methods are answered 404, as the Worker answers any route it does
// not have.
export function servePage(request: Request, path: string): Response {
  const file = files.get(path);
  if (file === undefined || (request.method !== "GET" && request.method !== "HEAD")) return notFound();
  const [body, type] = file;
  return new Response(request.method === "HEAD" ? null : body, { headers: { ...pageHeaders, "content-type": type } });
}

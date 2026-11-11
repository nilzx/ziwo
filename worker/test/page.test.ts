// The admin page at / and its files under /_page/: served with their
// security headers, refusing other methods, and never reaching a Durable
// Object. What the files hold is tested in Node (test/node/).

import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import { contentSecurityPolicy } from "../src/page";
import { adminSecret, fetchWorker, origin } from "./mcp-helpers";

const files: [path: string, type: string][] = [
  ["/", "text/html; charset=utf-8"],
  ["/_page/style.css", "text/css; charset=utf-8"],
  ["/_page/app.mjs", "text/javascript; charset=utf-8"],
  ["/_page/connect.mjs", "text/javascript; charset=utf-8"],
  ["/_page/dom.mjs", "text/javascript; charset=utf-8"],
  ["/_page/logic.mjs", "text/javascript; charset=utf-8"],
  ["/_page/seal.mjs", "text/javascript; charset=utf-8"],
  ["/_page/texts.mjs", "text/javascript; charset=utf-8"],
];

const securityHeaders = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'none'; " +
    "frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-cache",
};

// An environment whose namespaces fail any use, and count it.
function untouchable(): { env: Env; touched: string[] } {
  const touched: string[] = [];
  const ns = (label: string) =>
    new Proxy({}, {
      get(_t, prop) {
        touched.push(`${label}.${String(prop)}`);
        throw new Error(`${label} was reached`);
      },
    });
  return {
    env: {
      MEMORY: ns("MEMORY") as Env["MEMORY"], DIRECTORY: ns("DIRECTORY") as Env["DIRECTORY"], GUARD: ns("GUARD") as Env["GUARD"],
      OAUTH_KV: ns("OAUTH_KV") as Env["OAUTH_KV"],
      ADMIN_SECRET: adminSecret,
    },
    touched,
  };
}

describe("the admin page", () => {
  it("is served at / with its files, each with the security headers", async () => {
    for (const [path, type] of files) {
      const res = await fetchWorker(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe(type);
      for (const [k, v] of Object.entries(securityHeaders)) expect(res.headers.get(k), `${path} ${k}`).toBe(v);
      expect((await res.text()).length, path).toBeGreaterThan(100);
    }
    expect(contentSecurityPolicy).toBe(securityHeaders["content-security-policy"]);
  });

  it("is the document that loads the page's own files, and nothing else", async () => {
    const doc = await (await fetchWorker("/")).text();
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain(`<script type="module" src="/_page/app.mjs"></script>`);
    expect(doc).toContain(`<link rel="stylesheet" href="/_page/style.css">`);
    // Every file it names is served.
    const named = [...doc.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]!);
    expect(named.sort()).toEqual(["/_page/app.mjs", "/_page/style.css"]);
    // Every module the page imports is served too.
    for (const [path] of files.filter(([p]) => p.endsWith(".mjs"))) {
      const code = await (await fetchWorker(path)).text();
      for (const m of code.matchAll(/^import [^;]*? from "([^"]+)";$/gms)) {
        expect(m[1], path).toMatch(/^\.\/[a-z]+\.mjs$/);
        expect(files.map(([p]) => p), `${path} imports ${m[1]}`).toContain(`/_page/${m[1]!.slice(2)}`);
      }
    }
  });

  it("answers HEAD without a body, and other methods 404 as the Worker's other routes do", async () => {
    const head = await fetchWorker("/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-security-policy")).toBe(securityHeaders["content-security-policy"]);
    expect(await head.text()).toBe("");
    for (const [path] of files) {
      for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
        const res = await fetchWorker(path, { method });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(await res.text()).toBe("404 page not found\n");
      }
    }
  });

  it("answers 404 to a file it does not have", async () => {
    for (const path of ["/_page/", "/_page/nope.mjs", "/_page/index.html", "/_page/app.mjs/x", "/index.html", "/_pages/app.mjs"]) {
      const res = await fetchWorker(path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe("404 page not found\n");
    }
  });

  it("reaches no Durable Object, with or without a secret, by any method", async () => {
    const { env, touched } = untouchable();
    for (const [path] of files) {
      for (const method of ["GET", "HEAD", "POST"]) {
        for (const headers of [{}, { authorization: `Bearer ${adminSecret}` }, { authorization: "Bearer wrong" }] as Record<string, string>[]) {
          const res = await worker.fetch(new Request(origin + path, { method, headers }), env);
          expect(res.status, `${method} ${path}`).toBe(method === "POST" ? 404 : 200);
          await res.text();
        }
      }
    }
    expect(touched).toEqual([]);
    // The same environment does fail where a Durable Object is needed.
    const res = await worker.fetch(new Request(`${origin}/admin/memories`, { headers: { authorization: `Bearer ${adminSecret}` } }), env);
    expect(res.status).toBe(500);
    expect(touched.length).toBeGreaterThan(0);
  });
});

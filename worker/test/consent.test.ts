// The consent page: its headers, what it shows, that a forged or replayed
// post is refused, its two languages, and a client that names itself with a
// Client ID Metadata Document.

import { afterEach, describe, expect, it, vi } from "vitest";
import { consentPolicy } from "../src/consent";
import { consentTexts, pickLang } from "../src/consent-texts";
import { adminSecret, createMemory, fetchWorker, origin } from "./mcp-helpers";
import { approve, authorizePath, codeFrom, openPage, type Page, pkce, register, resourceOf, submit } from "./oauth-helpers";

async function consentPage(loopback = false, headers: Record<string, string> = {}): Promise<{ page: Page; name: string; token: string }> {
  const m = await createMemory();
  const redirect = loopback ? "http://127.0.0.1/callback" : undefined;
  const clientId = await register("Page <client> & co", redirect ?? "https://client.example/callback");
  const p = await pkce();
  const path = authorizePath({ clientId, challenge: p.challenge, resource: resourceOf(m.name), redirect: loopback ? "http://127.0.0.1:53682/callback" : undefined });
  return { page: await openPage(path, headers), name: m.name, token: m.token };
}

const message = (html: string) => /<p class="out error" role="alert">([^<]*)<\/p>/.exec(html)?.[1];

describe("the consent page", () => {
  it("is sent with a strict policy, cannot be framed or cached, and binds itself to the browser", async () => {
    const { page } = await consentPage();
    const h = page.res.headers;
    expect(h.get("content-type")).toBe("text/html; charset=utf-8");
    expect(h.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https://client.example; frame-ancestors 'none'; " +
        "base-uri 'none'; require-trusted-types-for 'script'",
    );
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("referrer-policy")).toBe("same-origin");
    expect(h.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(h.get("cache-control")).toBe("no-store");
    const cookies = h.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^__Host-oauth-consent-[0-9a-f]{16}=[0-9a-f]{64}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
    // No script of any kind, no inline style, and only the admin page's style sheet.
    expect(page.html).not.toMatch(/<script|\son[a-z]+=|style=|javascript:/i);
    expect([...page.html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]).filter((u) => !u!.startsWith("/oauth/authorize?"))).toEqual(["/_page/style.css"]);
    expect(consentPolicy()).not.toContain("script-src");
  });

  it("names the client as it registered, escaped, where it sends the person back, and the memory", async () => {
    const { page, name } = await consentPage();
    expect(page.html).toContain("<strong>Page &#60;client&#62; &#38; co</strong>");
    expect(page.html).not.toContain("<client>");
    expect(page.html).toContain("The client gave this name itself; it is not verified.");
    expect(page.html).toContain("<strong>client.example</strong><br><code>https://client.example/callback</code>");
    expect(page.html).toContain(`<code>${origin}/${name}/mcp</code>`);
    expect(page.html).not.toContain("a program on this computer");
    expect(page.fields.memory).toBe(name);
  });

  it("warns when it sends access to a program on this computer, and lets the form go there", async () => {
    const { page } = await consentPage(true);
    expect(page.res.status).toBe(200);
    expect(page.html).toContain("This sends access to a program on this computer.");
    expect(page.res.headers.get("content-security-policy")).toContain("form-action 'self' http://127.0.0.1:53682;");
  });

  it("refuses a post from another origin, one without the browser's cookie, and a replay", async () => {
    const { page, token } = await consentPage();
    for (const opts of [{ origin: "https://evil.example" }, { origin: null }, { origin: "null" }, { origin: null, fetchSite: "cross-site" },
      { origin: `${origin}.evil.example` }]) {
      const res = await submit(page, { decision: "approve", credential: token }, opts);
      expect(res.status, JSON.stringify(opts)).toBe(403);
      expect(message(await res.text())).toBe("This approval was not sent from this page, so it was not accepted. Start again from the client.");
    }
    // Same origin but another browser: the library's binding cookie is missing.
    const stranger = await submit(page, { decision: "approve", credential: token }, { cookie: null });
    expect(stranger.status).toBe(400);
    expect(message(await stranger.text())).toBe("This page has expired, was already used, or was opened in another browser. Start again from the client.");
    // A handle that is not this page's.
    const other = await submit(page, { decision: "approve", credential: token, handle: "x".repeat(43) });
    expect(other.status).toBe(400);
    // Where Origin is withheld, Sec-Fetch-Site vouches for the page.
    const ok = await submit(page, { decision: "approve", credential: token }, { origin: null, fetchSite: "same-origin" });
    expect(codeFrom(ok).get("code")).not.toBeNull();
    // The handle works once.
    const replay = await approve(page, token);
    expect(replay.status).toBe(400);
    expect(replay.headers.get("location")).toBeNull();
  });

  it("refuses a form whose memory is not the one the request asked for, after taking the handle", async () => {
    const { page } = await consentPage();
    const other = await createMemory();
    const res = await submit(page, { decision: "approve", credential: other.token, memory: other.name });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(message(await res.text())).toBe("This request cannot go on. Start again from the client.");
    // Not a form at all.
    const bad = await fetchWorker("/oauth/authorize", { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(400);
    expect((await fetchWorker("/oauth/authorize", { method: "PUT" })).status).toBe(405);
  });

  it("speaks Simplified Chinese when asked, in the browser or by its switch, and keeps the request when switching", async () => {
    const zh = await consentPage(false, { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" });
    expect(zh.page.html).toContain('<html lang="zh-CN">');
    expect(zh.page.html).toContain(consentTexts.zh.credLabel);
    const toggle = /<a href="([^"]+)" lang="en">English<\/a>/.exec(zh.page.html)![1]!.replaceAll("&#38;", "&");
    const en = await openPage(toggle);
    expect(en.res.status).toBe(200);
    expect(en.html).toContain('<html lang="en">');
    expect(en.fields.memory).toBe(zh.name);
    // The refusal speaks the page's language.
    const res = await approve(zh.page, "wrong");
    expect(message(await res.text())).toBe(consentTexts.zh.refused);
    expect(pickLang(null, "fr, de")).toBe("en");
    expect(pickLang("zh", "en")).toBe("zh");
    expect(pickLang(null, "fr, zh-TW;q=0.5")).toBe("zh");
  });

  it("holds the same texts, with the same placeholders, in both languages, none empty", () => {
    const placeholders = (s: string) => [...s.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]).sort();
    expect(Object.keys(consentTexts.zh).sort()).toEqual(Object.keys(consentTexts.en).sort());
    for (const k of Object.keys(consentTexts.en) as (keyof typeof consentTexts.en)[]) {
      expect(placeholders(consentTexts.zh[k]), k).toEqual(placeholders(consentTexts.en[k]));
      expect(consentTexts.en[k].trim(), k).not.toBe("");
      expect(consentTexts.zh[k].trim(), k).not.toBe("");
    }
  });
});

describe("a client that names itself with a metadata document", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is fetched, shown with its domain, and granted", async () => {
    const clientId = "https://app.example/oauth/client.json";
    const doc = { client_id: clientId, client_name: "Published app", redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" };
    const real = globalThis.fetch;
    const fetched: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://app.example/")) return real(input, init);
      fetched.push(url);
      return new Response(JSON.stringify(doc), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    });
    const m = await createMemory();
    const p = await pkce();
    const page = await openPage(authorizePath({ clientId, challenge: p.challenge, resource: resourceOf(m.name), redirect: "https://app.example/cb" }));
    expect(page.res.status, page.html).toBe(200);
    expect(fetched).toContain(clientId);
    expect(page.html).toContain("<strong>Published app</strong>");
    expect(page.html).toContain("Published by <strong>app.example</strong>.");
    const res = await submit(page, { decision: "approve", credential: adminSecret });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")!.startsWith("https://app.example/cb?code=")).toBe(true);
  });

  it("is answered here when the document cannot be fetched", async () => {
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.startsWith("https://gone.example/") ? new Response("no", { status: 404 }) : real(input, init);
    });
    const m = await createMemory();
    const res = await fetchWorker(authorizePath({ clientId: "https://gone.example/client.json", challenge: (await pkce()).challenge, resource: resourceOf(m.name) }));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("could not be fetched, or is not valid");
  });
});

// The consent page: its headers, what it shows, that a forged post is
// refused, that a request changed between the page and the post is refused
// or acted on only as that request on its own would be, its two languages,
// and a client that names itself with a Client ID Metadata Document.

import { afterEach, describe, expect, it, vi } from "vitest";
import { consentPolicy } from "../src/consent";
import { consentTexts, pickLang } from "../src/consent-texts";
import { exampleAdminSecret, minAdminSecret } from "../src/admin";
import { adminSecret, createMemory, fetchWorker, origin, testEnv } from "./mcp-helpers";
import {
  approve, authorizePath, codeFrom, countingEnv, exchange, openPage, type Page, pkce, redirectUri, register, resourceOf, submit,
} from "./oauth-helpers";

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
  it("is sent with a strict policy, cannot be framed or cached, and sets no cookie", async () => {
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
    expect(h.getSetCookie()).toEqual([]);
    // The form carries the request as it came, and no handle.
    expect(Object.keys(page.fields).sort()).toEqual(["hl", "memory", "q"]);
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

  it("refuses a post from another origin, and takes one from this origin in any browser", async () => {
    const { page, name, token } = await consentPage();
    for (const opts of [{ origin: "https://evil.example" }, { origin: null }, { origin: "null" }, { origin: null, fetchSite: "cross-site" },
      { origin: `${origin}.evil.example` }]) {
      const res = await submit(page, { decision: "approve", credential: token }, opts);
      expect(res.status, JSON.stringify(opts)).toBe(403);
      expect(message(await res.text())).toBe("This approval was not sent from this page, so it was not accepted. Start again from the client.");
    }
    // Where Origin is withheld, Sec-Fetch-Site vouches for the page. There
    // is no cookie to bind the post to the browser that opened the page.
    const ok = await submit(page, { decision: "approve", credential: token }, { origin: null, fetchSite: "same-origin", cookie: null });
    expect(codeFrom(ok).get("code")).not.toBeNull();
    // The same form again is a new approval: a new grant, and the client's
    // earlier one for this memory is revoked by the library.
    expect(codeFrom(await approve(page, token)).get("code")).not.toBeNull();
    const grants = await fetchWorker(`/admin/memories/${name}/grants`, { headers: { authorization: `Bearer ${adminSecret}` } });
    expect(((await grants.json()) as { grants: unknown[] }).grants).toHaveLength(1);
  });

  it("refuses a form whose memory is not the one the request names, writing nothing", async () => {
    const { page } = await consentPage();
    const other = await createMemory();
    const { env: e, writes } = countingEnv();
    const res = await submit(page, { decision: "approve", credential: other.token, memory: other.name }, { env: e });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(message(await res.text())).toBe("This request cannot go on. Start again from the client.");
    expect(writes).toEqual([]);
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

describe("a request changed between the page and the post", () => {
  async function setUp() {
    const m = await createMemory();
    const clientId = await register("Asked client");
    const p = await pkce();
    const page = await openPage(authorizePath({ clientId, challenge: p.challenge, resource: resourceOf(m.name), state: "st-t" }));
    expect(page.res.status).toBe(200);
    return { m, clientId, p, page };
  }

  // withQ is the page's form with its request changed.
  function withQ(page: Page, change: (q: URLSearchParams) => void): Page {
    const q = new URLSearchParams(page.fields.q);
    change(q);
    return { ...page, fields: { ...page.fields, q: q.toString() } };
  }

  const grantsOf = async (name: string): Promise<string[]> => {
    const res = await fetchWorker(`/admin/memories/${name}/grants`, { headers: { authorization: `Bearer ${adminSecret}` } });
    return ((await res.json()) as { grants: { client: string }[] }).grants.map((g) => g.client);
  };

  it("to another client is that client's own request: approved for it, and only its code exchange works", async () => {
    const { m, clientId, p, page } = await setUp();
    const other = await register("Other client");
    const code = codeFrom(await approve(withQ(page, (q) => q.set("client_id", other)), m.token)).get("code")!;
    expect(await grantsOf(m.name)).toEqual(["Other client"]);
    expect((await exchange(code, clientId, p.verifier, resourceOf(m.name))).status).toBe(400);
    expect((await exchange(code, other, p.verifier, resourceOf(m.name))).status).toBe(200);
    // A client that is not there is refused here, approved or denied, and nothing is written.
    const { env: e, writes } = countingEnv();
    const nobody = withQ(page, (q) => q.set("client_id", "AAAAAAAAAAAAAAAA"));
    for (const values of [{ decision: "approve", credential: m.token }, { decision: "deny" }] as Record<string, string>[]) {
      const res = await submit(nobody, values, { env: e });
      expect(res.status, values.decision).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(message(await res.text())).toBe("This request cannot go on. Start again from the client.");
    }
    expect(writes).toEqual([]);
  });

  it("to another redirect URI is refused here, approved or denied, unless the client registered it: then it is sent there", async () => {
    const m = await createMemory();
    const second = "https://client.example/second";
    const reg = await fetchWorker("/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Two doors", redirect_uris: [redirectUri, second], token_endpoint_auth_method: "none" }),
    });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const p = await pkce();
    const page = await openPage(authorizePath({ clientId, challenge: p.challenge, resource: resourceOf(m.name) }));
    const { env: e, writes } = countingEnv();
    const evil = withQ(page, (q) => q.set("redirect_uri", "https://evil.example/cb"));
    for (const values of [{ decision: "approve", credential: m.token }, { decision: "deny" }] as Record<string, string>[]) {
      const res = await submit(evil, values, { env: e });
      expect(res.status, values.decision).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    expect(writes).toEqual([]);
    const code = codeFrom(await approve(withQ(page, (q) => q.set("redirect_uri", second)), m.token), second).get("code")!;
    expect((await exchange(code, clientId, p.verifier, resourceOf(m.name), undefined, second)).status).toBe(200);
  });

  it("to another memory is refused unless the credential is right for that memory, as on its own page", async () => {
    const { m, page } = await setUp();
    const other = await createMemory();
    const { env: e, writes } = countingEnv();
    // The request names the other memory, the form this one: refused.
    const toOther = withQ(page, (q) => q.set("resource", resourceOf(other.name)));
    const res = await approve(toOther, m.token, e);
    expect(res.status).toBe(400);
    expect(message(await res.text())).toBe("This request cannot go on. Start again from the client.");
    // Both name the other memory: this memory's token is not its credential.
    const both: Page = { ...toOther, fields: { ...toOther.fields, memory: other.name } };
    const wrong = await approve(both, m.token, e);
    expect(wrong.status).toBe(403);
    expect(message(await wrong.text())).toBe("Not accepted. Check what you typed and try again.");
    // The memory parameter in place of the resource is read as the page
    // reads it, trimmed.
    const byParam = withQ(page, (q) => {
      q.delete("resource");
      q.set("memory", other.name);
    });
    expect((await approve(byParam, m.token, e)).status).toBe(400);
    expect(writes).toEqual([]);

    // Its own token, or the admin secret, approves it for that memory.
    for (const credential of [other.token, adminSecret]) {
      const code = codeFrom(await approve(both, credential)).get("code")!;
      expect(code.startsWith(`${other.name}:`)).toBe(true);
    }
    expect(await grantsOf(m.name)).toEqual([]);
    const spaced = withQ(page, (q) => {
      q.delete("resource");
      q.set("memory", ` ${m.name} `);
    });
    expect(codeFrom(await approve(spaced, m.token)).get("code")!.startsWith(`${m.name}:`)).toBe(true);
  });

  it("without PKCE is sent back with invalid_request, as the page would be, and a changed challenge binds the code to it", async () => {
    const { m, clientId, p, page } = await setUp();
    const { env: e, writes } = countingEnv();
    const noPkce = withQ(page, (q) => {
      q.delete("code_challenge");
      q.delete("code_challenge_method");
    });
    const back = codeFrom(await approve(noPkce, m.token, e));
    expect(back.get("error")).toBe("invalid_request");
    expect(back.get("state")).toBe("st-t");
    expect(back.get("code")).toBeNull();
    // Denied, the library refuses it (a public client must use PKCE): answered here.
    expect((await submit(noPkce, { decision: "deny" }, { env: e })).status).toBe(400);
    expect(writes).toEqual([]);
    expect(await grantsOf(m.name)).toEqual([]);
    const fresh = await pkce();
    const code = codeFrom(await approve(withQ(page, (q) => q.set("code_challenge", fresh.challenge)), m.token)).get("code")!;
    expect((await exchange(code, clientId, p.verifier, resourceOf(m.name))).status).toBe(400);
    expect((await exchange(code, clientId, fresh.verifier, resourceOf(m.name))).status).toBe(200);
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

  it("is not approved by an admin secret that does not count, though it is the one set", async () => {
    const m = await createMemory();
    for (const secret of [exampleAdminSecret, "x".repeat(minAdminSecret - 1)]) {
      const e = testEnv(secret);
      const clientId = await register("Test client", undefined, e);
      const p = await pkce();
      const page = await openPage(authorizePath({ clientId, challenge: p.challenge, resource: resourceOf(m.name) }), {}, e);
      expect(page.res.status, page.html).toBe(200);
      expect((await approve(page, secret, e)).status, secret).toBe(403);
      // The memory's own token still approves.
      expect((await approve(page, m.token, e)).status).toBe(302);
    }
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

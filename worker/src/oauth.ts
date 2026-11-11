// OAuth for the memories, with @cloudflare/workers-oauth-provider. The Worker
// is the authorization server of its own origin, and each memory's address,
// /<name>/mcp, is a protected resource of its own: what is issued for one
// memory is refused at every other.
//
// The library fixes its list of resources when it is built, and the names of
// memories are not known in advance. So a server is built for each request,
// with the one resource that request concerns: the memory its path names, its
// resource indicator names, or the code or token it carries belongs to (the
// library writes a grant's user id in front of every code and token, and the
// user id of a grant is the memory's name). The library then checks every
// binding itself; a request that concerns no memory gets a placeholder that
// no grant is ever made for.
//
// Nothing here is on the path of a request that carries a memory's fixed
// token: index.ts sends those to the memory's object, as before.

import { OAuthAuthorizationServer, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Note } from "./admin";
import { notFound, plain, validName } from "./http";
import type { Env } from "./index";

// Lifetimes in seconds. An access token lasts an hour; a grant lasts while it
// is used and lapses after 30 days without a refresh. The library fixes the
// rest: an authorization code and a consent page's handle last 10 minutes, a
// client that registered itself 90 days, renewed while it is used.
export const accessTokenTTL = 3600;
export const grantIdleTTL = 30 * 24 * 3600;

export const paths = {
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  register: "/oauth/register",
  serverMetadata: "/.well-known/oauth-authorization-server",
  resourceMetadata: "/.well-known/oauth-protected-resource",
} as const;

// What a grant carries, sealed by the library with its tokens.
export interface GrantProps {
  memory: string;
  client: string;
  // The memory's instance when the grant was given (memory-object.ts); a
  // grant from before instances were recorded has none and is not checked.
  instance?: string;
}

// What the admin page shows of a grant, unsealed in KV.
export interface GrantMetadata {
  client: string;
  via: "admin" | "token";
  // The memory's instance, as in the props: the admin API tells by it a
  // grant left over from a memory deleted under the same name.
  instance?: string;
}

function loopback(host: string): boolean {
  return host === "localhost" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

// issuerOf is the issuer for requests to url: its origin, when OAuth can be
// offered there. The library takes https, or http on a loopback host only
// (wrangler dev); elsewhere there is no OAuth.
export function issuerOf(url: URL): string | undefined {
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback(url.hostname))) return url.origin;
  return undefined;
}

export const resourceOf = (issuer: string, name: string): string => `${issuer}/${name}/mcp`;
export const resourceMetadataOf = (issuer: string, name: string): string => `${issuer}${paths.resourceMetadata}/${name}/mcp`;

// memoryOfResource reads the memory a resource indicator names on this
// issuer. Scheme and host are compared without case, as the specification
// asks; a query is left for the library to judge.
export function memoryOfResource(issuer: string, value: string): string | undefined {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return undefined;
  }
  if (u.origin !== issuer || u.hash !== "") return undefined;
  const m = /^\/([^/]+)\/mcp$/.exec(u.pathname);
  return m !== null && validName(m[1]!) ? m[1] : undefined;
}

// memoryOfToken reads the memory in front of a code, an access token or a
// refresh token the library issued. It proves nothing: the library checks
// the rest against KV.
export function memoryOfToken(value: string): string | undefined {
  const m = /^([a-z0-9][a-z0-9_-]{0,31}):/.exec(value);
  return m !== null && validName(m[1]!) ? m[1] : undefined;
}

// A fixed token is "ziwo_" and base64url: it never holds a colon, and every
// token the library issues does.
export const isOAuthToken = (token: string): boolean => token.includes(":");

// A resource no memory can have: a name starts with a letter or a digit.
const placeholder = "/_none";

// The outcome of the library's own refusals, for the access log: its error
// code and the name of the check that failed, both fixed words.
function noteError(note: Note | undefined): (e: { code: string; internal: { reason: string } }) => undefined {
  return (e) => {
    if (note !== undefined) {
      note.outcome = word(e.code);
      note.reason = word(e.internal.reason);
    }
    return undefined;
  };
}

// word keeps a fixed word fixed: anything else in it is dropped.
export function word(s: string): string {
  return s.replace(/[^a-z0-9_-]/gi, "").slice(0, 64);
}

// authServer builds the authorization server for one request, with the
// resources of the memories named, or the placeholder.
export function authServer(issuer: string, names: readonly string[], note?: Note): OAuthAuthorizationServer<Env> {
  const unique = [...new Set(names)];
  return new OAuthAuthorizationServer<Env>({
    issuer,
    resources: unique.length > 0 ? unique.map((n) => resourceOf(issuer, n)) : [issuer + placeholder],
    authorizeEndpoint: paths.authorize,
    tokenEndpoint: paths.token,
    clientRegistrationEndpoint: paths.register,
    accessTokenTTL,
    refreshTokenTTL: grantIdleTTL,
    refreshTokenIdleTTL: grantIdleTTL,
    // Client ID Metadata Documents: the wrangler files set the compatibility
    // flag global_fetch_strictly_public, which the library needs for them.
    clientIdMetadataDocumentEnabled: true,
    // The library's default writes the error's description to the log.
    onError: noteError(note),
  });
}

// helpersFor gives the library's helpers for one memory's grants. Listing and
// revoking read KV only, so any issuer the library accepts will do when the
// request came over plain http from elsewhere.
export function helpersFor(env: Env, url: URL, name: string): OAuthHelpers {
  return authServer(issuerOf(url) ?? "http://localhost", [name]).getOAuthApi(env);
}

// challenge is the 401 of a memory's address. It points at the memory's
// metadata, so that a client can find the authorization server, and says the
// token was refused when one was presented. It is the same for every name,
// so that it tells nothing about which memories exist, and it reads nothing.
export function challenge(url: URL, name: string, presented: boolean): Response {
  const issuer = issuerOf(url);
  let value = 'Bearer realm="ziwo"';
  if (issuer !== undefined) value += `, resource_metadata="${resourceMetadataOf(issuer, name)}"`;
  if (presented) value += ', error="invalid_token"';
  return plain(401, "unauthorized", { "www-authenticate": value });
}

// oauthAccess checks an access token presented at a memory's address: the
// library finds its record in KV, checks its expiry and that it was issued
// for this memory's resource, and opens the grant's props. null refuses.
export async function oauthAccess(env: Env, issuer: string, name: string, token: string): Promise<GrantProps | null> {
  const v = await authServer(issuer, [name]).validateToken<GrantProps>(resourceOf(issuer, name), token, env);
  if (v === null || v.props?.memory !== name) return null;
  return v.props;
}

const corsMetadata = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-max-age": "86400",
};

// protectedResource serves a memory's RFC 9728 metadata. Every valid name has
// one, so that it says nothing about which memories exist; it reaches no
// object and no KV.
function protectedResource(request: Request, issuer: string, name: string): Response {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsMetadata });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain(405, "Method Not Allowed", { allow: "GET, HEAD, OPTIONS" });
  }
  const body = JSON.stringify({
    resource: resourceOf(issuer, name),
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    resource_name: `ziwo memory ${name}`,
  });
  return new Response(request.method === "HEAD" ? null : body, {
    headers: { "content-type": "application/json", "cache-control": "no-store", ...corsMetadata },
  });
}

// serverMetadata serves RFC 8414 metadata as the library writes it, without
// protected_resources: it would list the placeholder, and listing the memories
// would tell their names. The member is optional (RFC 9728, section 4).
async function serverMetadata(request: Request, env: Env, ctx: ExecutionContext | undefined, issuer: string): Promise<Response> {
  const res = await libraryFetch(authServer(issuer, []), request, env, ctx);
  if (!res.ok || request.method !== "GET") return res;
  const doc = (await res.json()) as Record<string, unknown>;
  delete doc.protected_resources;
  return new Response(JSON.stringify(doc), { status: res.status, headers: res.headers });
}

// libraryFetch serves one of the library's own endpoints: metadata, token,
// registration. Those await all their work and never touch the context, so
// a call without one (the tests') is served the same.
function libraryFetch(server: OAuthAuthorizationServer<Env>, request: Request, env: Env, ctx: ExecutionContext | undefined): Promise<Response> {
  return server.fetch(request, env, ctx as ExecutionContext);
}

// The largest token request read twice: once here for the memory it concerns,
// once by the library.
const maxPeek = 64 * 1024;

// memoriesOfTokenRequest names the memory a token or revocation request
// concerns, from the code or token it carries. A resource indicator that
// names another memory is the library's to refuse: it is not on the list.
async function memoriesOfTokenRequest(request: Request): Promise<{ names: string[]; kind: string }> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const length = Number(request.headers.get("content-length") ?? "0");
  if (request.method !== "POST" || type !== "application/x-www-form-urlencoded" || !(length <= maxPeek)) return { names: [], kind: "" };
  let form: URLSearchParams;
  try {
    // As bytes: the runtime warns when a form body is read as text.
    form = new URLSearchParams(new TextDecoder().decode(await request.clone().arrayBuffer()));
  } catch {
    return { names: [], kind: "" };
  }
  const names: string[] = [];
  for (const k of ["code", "refresh_token", "token"]) {
    const n = memoryOfToken(form.get(k) ?? "");
    if (n !== undefined) names.push(n);
  }
  const grant = form.get("grant_type");
  const kind = grant === "authorization_code" ? "issued" : grant === "refresh_token" ? "refreshed" : grant === null && form.has("token") ? "revoked" : "";
  return { names, kind };
}

// isOAuthPath says whether a path is one of the authorization server's, or
// the well-known metadata of one.
export function isOAuthPath(path: string): boolean {
  return path.startsWith("/oauth/") || path.startsWith("/.well-known/");
}

// serveOAuth answers the endpoints of the authorization server and the
// metadata documents. The consent page, at the authorization endpoint, is
// consent.ts's.
export async function serveOAuth(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  path: string,
  note: Note,
  authorize: (issuer: string) => Promise<Response>,
): Promise<Response> {
  const issuer = issuerOf(new URL(request.url));
  if (issuer === undefined) return notFound();
  const prm = new RegExp(`^${paths.resourceMetadata}/([^/]+)/mcp$`).exec(path);
  if (prm !== null) {
    if (!validName(prm[1]!)) return notFound();
    note.oauth = "resource-metadata";
    return protectedResource(request, issuer, prm[1]!);
  }
  switch (path) {
    case paths.serverMetadata:
      note.oauth = "server-metadata";
      return serverMetadata(request, env, ctx, issuer);
    case paths.authorize:
      note.oauth = "authorize";
      return authorize(issuer);
    case paths.register: {
      note.oauth = "register";
      const res = await libraryFetch(authServer(issuer, [], note), request, env, ctx);
      if (res.status === 201) note.outcome = "registered";
      return res;
    }
    case paths.token: {
      note.oauth = "token";
      const { names, kind } = await memoriesOfTokenRequest(request);
      const res = await libraryFetch(authServer(issuer, names, note), request, env, ctx);
      if (res.ok && kind !== "") note.outcome = kind;
      return res;
    }
  }
  return notFound();
}

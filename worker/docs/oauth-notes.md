# OAuth: what it rests on

Fetched 2026-11-12. The code is `src/oauth.ts` (authorization server, metadata, the 401), `src/consent.ts` (the consent page) and the grants routes in `src/admin.ts`.

## Sources

- MCP authorization, latest (2026-07-28): https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization.md, with its pages [authorization-server-discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery.md), [client-registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration.md) and [security-considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations.md).
- MCP authorization, the version before (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization.md. Same shape; CIMD SHOULD, DCR MAY in both.
- `@cloudflare/workers-oauth-provider` 1.2.4: its README and `docs/` in `node_modules/@cloudflare/workers-oauth-provider/` (authorization-server.md, resource-servers.md, consent-page.md, mcp-discovery.md), and its source in `dist/oauth-provider.js` for what the docs leave open (token format `<userId>:<grantId>:<secret>`, the code's 10-minute life, revocation deleting a grant's tokens).
- Cloudflare, MCP authorization: https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/index.md (the path in the brief redirects here). KV consistency: https://developers.cloudflare.com/kv/concepts/how-kv-works/index.md ("up to 60 seconds or more").
- Anthropic: https://claude.com/docs/connectors/building/authentication.md (401 with `resource_metadata`; CIMD used only with `"none"` among the token auth methods; callback `https://claude.ai/api/mcp/auth_callback`; Claude Code's loopback callback on any port for `localhost` and `127.0.0.1`; refresh tokens rotated; `invalid_grant` for a dead refresh token), https://claude.com/docs/connectors/custom/add-unlisted.md (the steps in the Claude apps), https://code.claude.com/docs/en/mcp.md (`/mcp`, `claude mcp login`).
- OpenAI: https://developers.openai.com/plugins/build/auth.md (PKCE S256 advertised, `iss` on every authorization response when advertised, CIMD with `none` or `private_key_jwt`, DCR), https://developers.openai.com/plugins/deploy/connect-chatgpt.md (adding a custom MCP server in ChatGPT), https://developers.openai.com/codex/mcp.md (`codex mcp login`). The help-center article on developer mode refused automated fetching (403).

## How a memory's address is a resource of its own

The library fixes its list of resources at construction. The Worker builds a server per request with the one resource the request concerns: `https://<origin>/<name>/mcp` from the path, from the `resource` parameter, or from the memory name the library puts in front of each code and token (the grant's `userId` is the memory's name). The issuer is the request's origin (https, or http on a loopback host). Addresses given to clients are unchanged.

## Deleting a memory, and the limit on guessing

Fetched 2026-11-12: Durable Object storage (`deleteAll`, the synchronous KV API): https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/index.md; alarms: https://developers.cloudflare.com/durable-objects/api/alarms/index.md; the rate limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/index.md.

- `DELETE /admin/memories/<name>?confirm=<name>` revokes the memory's grants, empties its object and unlists the name (`serveDelete` in `src/admin.ts`). KV lists lag, so a grant given seconds before can be missed and outlive the memory in KV; each grant records the memory's instance id (`meta.instance`, drawn anew for every memory made), and the object refuses a tool call whose grant names another instance or that reaches it empty. Discovery and `tools/list` do not reach the object and still answer such a token until KV forgets it.
- `deleteAll()` also deletes the alarm from compatibility date 2026-02-24; `remove()` calls `deleteAlarm()` as well.
- The limit on guessing (`src/guard.ts`) is a Durable Object per address, not the rate limiting binding: `limit()` always counts, so it cannot refuse a right credential during a lock without counting it; its counts are per location and approximate; it needs a `namespace_id` unique in the deployer's account.

## What writes to KV, and what it takes

A free account's KV takes 1,000 writes a day (puts and deletes together), and every client's renewal costs two, so nothing a caller sends without a credential writes to KV. Read from `dist/oauth-provider.js` of the library 1.2.4 on 2026-11-12; `test/oauth-writes.test.ts` counts the writes. Every write and delete that is left, and what the caller must hold:

| Write | Caused by | The caller must hold |
| --- | --- | --- |
| put `client:` | `POST /oauth/register` | a registration within the budget: at most 10 an hour from one address and `REGISTER_PER_DAY` (default 100, 0 is off) in any 24 hours in all, counted in the `Guard` objects before the library sees the request; one the library then refuses still counts |
| put `client:` | the library renewing a registered client past half its 90 days, after any token endpoint answer that is not an error (an exchange, a refresh, or a revocation, which answers 200 even for a made-up token) | the id of a client registered within the budget; at most once per client per 45 days, so at most as many writes as registrations |
| put `grant:` | an approval on the consent page (`completeAuthorization`) | the memory's token or the admin secret, past the limit on guessing |
| delete `grant:`, `token:` | the same approval: the library revokes the client's earlier grants for that memory | the same |
| put `grant:`, put `token:` | exchanging a code | a code that was issued, with its PKCE verifier |
| delete `token:`, `grant:` | a code presented a second time: the library revokes its grant | a code that was issued and used |
| put `grant:`, put `token:` | a refresh | a refresh token that was issued (the current one or the one before it) |
| delete `token:`, or `token:` and `grant:` | a revocation (RFC 7009) | an access or refresh token that was issued, with the id of the client it was issued to |
| delete `token:`, `grant:` | listing a memory's grants (revokes grants left over from a deleted memory), revoking a grant, deleting a memory | the admin secret |

Nothing else writes: showing the consent page, the page again after a wrong credential, a denial and a forged post write nothing (the page keeps no consent transaction: `transaction:` is never written); a client assertion is refused before the library (`client-assertion-jti:` is never written); a made-up code, refresh token or access token, at the token endpoint or at a memory, is only read; a request with a memory's fixed token never reaches KV. Metadata documents are cached by the library in the Cache API, not in KV.

Not KV, but written without a credential: a wrong credential at the consent page or the admin API writes its address's `Guard` object (at most 10 a minute from one address), and an admitted registration writes two `Guard` objects. Durable Object writes are a budget of their own, and each needs a Worker request, which runs out no later.

## Steps in the page not checked against a running client

The Claude apps (web and phone) and ChatGPT (web, desktop and phone) have connected through sign-in to a deployed Worker (2026-11-12). Both identify themselves by a metadata document and authenticate with `none`: neither registered itself, and ChatGPT did so after `private_key_jwt` had been taken out of the metadata. The steps for Claude Code and Codex are written from the documentation above and have not been run against those clients. The flow itself was checked with curl and Chrome against `wrangler dev`, and with a script against the deployed Worker.

## Not built

- No OpenID Connect discovery, ID tokens or userinfo (not needed: RFC 8414 metadata is served).
- No scopes; `scopes_supported` is not advertised. A grant is the whole of one memory.
- No `client_credentials`, token exchange, private-use redirect schemes, or pre-registered clients.
- No `private_key_jwt`: a token request with `client_assertion` or `client_assertion_type` is refused with `invalid_client`, and the metadata does not offer it. A metadata document that offers `none` beside it works with `none` (the library prefers `none`); one that offers `private_key_jwt` alone is shown on the consent page but can never exchange its code.
- MCP says a server must accept only tokens its authorization server issued; the fixed token is accepted beside them, by decision.
- CORS on `/<name>/mcp` and its 401 is unchanged (none), so a browser-based MCP client cannot read the challenge.

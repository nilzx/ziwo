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

## Steps in the page not checked against a running client

None of the client steps were run against a client: every step for the Claude apps, Claude Code, ChatGPT, Codex and the ChatGPT desktop app is written from the documentation above. The flow itself was checked with curl and Chrome against `wrangler dev`.

## Not built

- No OpenID Connect discovery, ID tokens or userinfo (not needed: RFC 8414 metadata is served).
- No scopes; `scopes_supported` is not advertised. A grant is the whole of one memory.
- No `client_credentials`, token exchange, private-use redirect schemes, or pre-registered clients.
- MCP says a server must accept only tokens its authorization server issued; the fixed token is accepted beside them, by decision.
- CORS on `/<name>/mcp` and its 401 is unchanged (none), so a browser-based MCP client cannot read the challenge.

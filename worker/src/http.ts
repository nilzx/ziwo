// What the Worker's routes share: answers in the Go host's form, tokens and
// the bearer header, and the name rule.

export const encoder = new TextEncoder();

// plain answers as Go's http.Error does.
export function plain(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", ...headers },
  });
}

export const notFound = (): Response => plain(404, "404 page not found");
export const unauthorized = (): Response => plain(401, "unauthorized", { "www-authenticate": 'Bearer realm="ziwo"' });

export type JSONRecord = Record<string, unknown>;

export function json(status: number, body: JSONRecord): Response {
  return new Response(JSON.stringify(body) + "\n", { status, headers: { "content-type": "application/json" } });
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", encoder.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// newToken draws a token in Go's form: ziwo_ and 256 random bits.
export function newToken(): string {
  return "ziwo_" + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

// bearer reads the token of an Authorization header as Go's host does: the
// scheme in any case, the token trimmed. null means no header at all.
export function bearer(request: Request): string | null | undefined {
  const h = request.headers.get("authorization");
  if (h === null) return null;
  const at = h.indexOf(" ");
  const scheme = at < 0 ? h : h.slice(0, at);
  if (scheme.toLowerCase() !== "bearer") return undefined;
  return h.slice(at + 1).trim();
}

// The name rule of Go's host: lower case so a name means the same thing
// everywhere, and plain enough to sit in a URL path.
const nameRE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function validName(name: string): boolean {
  return nameRE.test(name) && name !== "healthz";
}

export function invalidNameMessage(name: string): string {
  return `invalid memory name ${JSON.stringify(name)}: use 1 to 32 lower-case letters, digits, - or _, starting with a letter or digit`;
}

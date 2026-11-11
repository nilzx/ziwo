// JSON written the way Go's encoding/json writes it, so that event payloads
// and stored content are byte for byte what the Go build wrote. Content is
// hashed in this form, and exports carry payloads as they are.

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | readonly JSONValue[]
  | { readonly [key: string]: JSONValue | undefined };

// Go escapes these for safe embedding in HTML; JSON.stringify does not.
const goExtraEscapes = /[<>&\u2028\u2029]/g;

function goString(s: string): string {
  // Go replaces invalid UTF-8 with U+FFFD; a lone surrogate is the JS analogue.
  return JSON.stringify(s.toWellFormed()).replace(
    goExtraEscapes,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

function goNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`json: unsupported value ${n}`);
  // Go's float64 format agrees with Number#toString, both shortest
  // round-trip with exponent below 1e-6 and from 1e21, except for -0.
  return Object.is(n, -0) ? "-0" : String(n);
}

// goJSON encodes v. Object keys keep their insertion order, and keys whose
// value is undefined are left out: that is how omitempty is expressed.
export function goJSON(v: JSONValue): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return goString(v);
    case "number":
      return goNumber(v);
    case "boolean":
      return v ? "true" : "false";
  }
  if (Array.isArray(v)) return "[" + v.map((x: JSONValue) => goJSON(x)).join(",") + "]";
  const parts: string[] = [];
  for (const [k, x] of Object.entries(v as { readonly [key: string]: JSONValue | undefined })) {
    if (x !== undefined) parts.push(goString(k) + ":" + goJSON(x));
  }
  return "{" + parts.join(",") + "}";
}

// Reading payloads back. Missing and null fields read as the zero value, as
// with Go's json.Unmarshal; a field of the wrong type is an error.

export type JSONObject = { readonly [key: string]: unknown };

export function parseObject(text: string, what: string): JSONObject {
  const v: unknown = JSON.parse(text);
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`${what}: not a JSON object`);
  }
  return v as JSONObject;
}

export function str(o: JSONObject, key: string): string {
  const v = o[key];
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new Error(`json: field ${key} is not a string`);
  return v;
}

export function num(o: JSONObject, key: string): number {
  const v = o[key];
  if (v === undefined || v === null) return 0;
  if (typeof v !== "number") throw new Error(`json: field ${key} is not a number`);
  return v;
}

export function int(o: JSONObject, key: string): number {
  const v = num(o, key);
  if (!Number.isSafeInteger(v)) throw new Error(`json: field ${key} is not an integer`);
  return v;
}

export function bool(o: JSONObject, key: string): boolean {
  const v = o[key];
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") throw new Error(`json: field ${key} is not a boolean`);
  return v;
}

export function strs(o: JSONObject, key: string): string[] {
  const v = o[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x): x is string => typeof x === "string")) {
    throw new Error(`json: field ${key} is not a list of strings`);
  }
  return v;
}

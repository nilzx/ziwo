// The deployment's configuration and the one tests and local runs use are
// the same apart from the AI binding, and the id of the OAuth namespace that
// the first deploy may write into the deployment's file.

import { describe, expect, it } from "vitest";
import deployed from "../wrangler.jsonc?raw";
import local from "../wrangler.dev.jsonc?raw";

// parse reads JSONC whose comments are whole lines.
function parse(text: string): Record<string, unknown> {
  const json = text
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  return JSON.parse(json) as Record<string, unknown>;
}

describe("wrangler configuration", () => {
  it("differs between deployment and local runs in the AI binding alone", () => {
    const d = parse(deployed);
    const l = parse(local);
    expect(d.ai).toEqual({ binding: "AI" });
    expect("ai" in l).toBe(false);
    const { ai: _ai, kv_namespaces: kv, ...rest } = d;
    const { kv_namespaces: localKV, ...localRest } = l;
    expect(rest).toEqual(localRest);
    // Wrangler writes the id of the namespace it created back into the file
    // it deployed from; that id is all the two may differ in.
    expect((kv as Record<string, unknown>[]).map(({ id: _id, ...k }) => k)).toEqual(localKV);
    expect(localKV).toEqual([{ binding: "OAUTH_KV" }]);
  });

  it("lets OAuth fetch a client's metadata document only on the public internet", () => {
    for (const c of [parse(deployed), parse(local)]) {
      expect(c.compatibility_flags).toEqual(["nodejs_compat", "global_fetch_strictly_public"]);
    }
  });
});

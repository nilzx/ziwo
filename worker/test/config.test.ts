// The deployment's configuration and the one tests and local runs use are
// the same apart from the AI binding.

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
    const { ai: _ai, ...rest } = d;
    expect(rest).toEqual(l);
  });
});

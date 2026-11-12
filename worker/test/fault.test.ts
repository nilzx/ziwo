// What the access log says of a refused call: the field at fault and the kind
// of complaint, read off the complaint's words, and nothing the caller sent.

import { describe, expect, it } from "vitest";
import { faultOf, tools } from "../src/mcp/tools";
import { Client, createMemory, idIn } from "./mcp-helpers";

const def = (name: string) => tools.find((t) => t.name === name)!;

describe("what a refused call was refused for", () => {
  it("names the field and the kind for the complaints the tools make", async () => {
    const m = await createMemory();
    const c = new Client("new", m, "fault-client");
    await c.connect();
    const s = idIn(await c.ok("get_context", {}), "s_");
    const id = idIn(await c.ok("remember", { session_id: s, gist: "a gist", body: "a body" }));
    // Each call is refused; the complaint as the model reads it is classed.
    const cases: [string, Record<string, unknown>, string, string][] = [
      ["remember", { gist: "g", body: "b" }, "session_id", "required"],
      ["remember", { session_id: "s_nothere1", gist: "g", body: "b" }, "session_id", "unknown_session"],
      ["remember", { session_id: s, gist: "g" }, "body", "required"],
      ["remember", { session_id: s, gist: "g".repeat(201), body: "b" }, "gist", "too_long"],
      ["remember", { session_id: s, gist: "g", body: 7 }, "body", "type"],
      ["remember", { session_id: s, gist: "g", body: "b", moment: "sometime" }, "moment", "value"],
      ["remember", { session_id: s, gist: "g", body: "b", importance: 2 }, "importance", "range"],
      ["remember", { session_id: s, gist: "g", body: "b", feeling_intensity: 0.5 }, "feeling_intensity", "needs"],
      ["remember", { session_id: s, gist: "g", body: "b", happened_at: "2026-01-01" }, "happened_at", "needs"],
      ["remember", { session_id: s, gist: "g", body: "b", source: "reconstructed", happened_at: "last week" }, "other", "date"],
      ["remember", { session_id: s, gist: "g", body: "b", people: Array.from({ length: 17 }, (_, i) => `p${i}`) }, "other", "too_many"],
      ["remember", { session_id: s, gist: "g", body: "b", gist_extra: "x" }, "other", "unknown_field"],
      ["recall", { since: "soon" }, "since", "date"],
      ["recall", { since: "2026-02-01", until: "2026-01-01" }, "since", "date"],
      ["expand", {}, "ids", "required"],
      ["amend", { session_id: s, action: "tidy", id }, "action", "value"],
      ["amend", { session_id: s, action: "pin", id: "m_nothere1" }, "id", "no_such"],
      ["amend", { session_id: s, action: "reweigh", id }, "importance", "required"],
      ["erase", { session_id: s }, "id", "required"],
      ["reflect", { session_id: s, batch: "b_x", entries: [{ kind: "lesson" }] }, "gist", "required"],
    ];
    for (const [tool, args, field, kind] of cases) {
      const r = await c.tool(tool, args);
      expect(r.isError, `${tool} ${JSON.stringify(args).slice(0, 60)}`).toBe(true);
      expect(faultOf(def(tool), r.text), r.text).toEqual({ field, kind });
    }
  });

  it("still reads null in place of a list as an empty list, though the schema shows a plain array", async () => {
    const m = await createMemory();
    const c = new Client("new", m, "fault-client");
    await c.connect();
    const s = idIn(await c.ok("get_context", {}), "s_");
    expect(await c.ok("remember", { session_id: s, gist: "a gist", body: "a body", people: null })).toMatch(/m_/);
    const listed = (await c.list()).find((t) => t.name === "remember") as { inputSchema: { properties: Record<string, { type: unknown }> } };
    expect(listed.inputSchema.properties.people!.type).toBe("array");
  });

  it("puts nothing of the caller's in the field: a word that is not one of the tool's fields is other", () => {
    expect(faultOf(def("amend"), "m_abc has been erased; there is nothing left to amend")).toEqual({ field: "id", kind: "state" });
    expect(faultOf(def("recall"), "gist is required")).toEqual({ field: "other", kind: "required" });
    expect(faultOf(def("remember"), 'secretword must be text; "secretword" is not a field of remember')).toEqual({ field: "other", kind: "type" });
    expect(faultOf(def("check"), "something nobody wrote yet")).toEqual({ field: "other", kind: "other" });
  });
});

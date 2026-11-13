// The reminders in remember's answer: a block of code or copied text, or a
// long account; and many moments in one conversation. The memory is written
// all the same. Made-up text throughout.

import { describe, expect, it, vi } from "vitest";
import type { Answer, RememberArgs } from "../src/memory-object";
import { longBody } from "../src/memory/clean";
import { manyMoments } from "../src/memory/service";
import { dump, minute, t0 } from "./helpers";
import { Client, createMemory, idIn, setClock } from "./mcp-helpers";
import { type Fixture, ok, start } from "./service-helpers";

function text(a: Answer): string {
  if ("text" in a) return a.text;
  expect.fail(`not a text answer: ${JSON.stringify(a)}`);
}

let n = 0;
function say(f: Fixture, more: Partial<RememberArgs> = {}): string {
  n++;
  const a = f.obj.answer({ tool: "remember", args: { sessionId: f.sess(), gist: `第${n}件`, body: `正文 ${n}`, ...more } });
  f.advance(minute);
  return text(a);
}

const keeps = "A memory keeps what the moment was like for you; the work itself stays where it lives, with its place in pointer.";
const block = `It holds a block of code or of copied text. ${keeps}`;
const long = (k: number) => `Its account runs to ${k} characters, which is long for a memory. ${keeps}`;
const many = (k: number) => `That makes ${k} moments written in this conversation. Not everything that happens needs one, and the steps of a task need none of their own.`;
const lines = (t: string) => t.split("\n").slice(1);

describe("the reminders", () => {
  it("name a fenced block, at the start of a line, with backticks or tildes", () =>
    start((f) => {
      expect(lines(say(f, { body: "我写下了这些：\n```\nlet x = 1;\n```" }))).toEqual([block]);
      expect(lines(say(f, { body: "~~~\n抄来的一段\n~~~" }))).toEqual([block]);
      expect(lines(say(f, { body: "提到了 ``` 但不在行首" }))).toEqual([]);
    }));

  it("name a long account from 1,501 code points, and a block before length", () =>
    start((f) => {
      expect(longBody).toBe(1500);
      // Chinese: 1,500 code points are 4,500 bytes.
      expect(lines(say(f, { body: "长".repeat(1500) }))).toEqual([]);
      expect(lines(say(f, { body: "长".repeat(1501) }))).toEqual([long(1501)]);
      expect(lines(say(f, { body: "```\n" + "长".repeat(1600) }))).toEqual([block]);
    }));

  it("count the moments a conversation wrote as they happened, from the one after manyMoments", () =>
    start((f) => {
      expect(manyMoments).toBe(30);
      for (let i = 1; i <= manyMoments; i++) expect(lines(say(f)), `moment ${i}`).toEqual([]);
      // Reconstructed and corrected ones do not count, and get no reminder.
      expect(lines(say(f, { source: "reconstructed", happenedAt: "2026-01-01" }))).toEqual([]);
      const fixed = ok(f.obj.amend({ sessionId: f.sess(), action: "correct", id: f.st.recent(f.st.clock(), 1)[0]!.id, gist: "改过" }));
      expect(fixed).not.toMatch(/moments written/);
      const first = say(f);
      expect(first).toMatch(/^remembered as m_[a-z2-9]{8}\n/);
      expect(lines(first)).toEqual([many(manyMoments + 1)]);
      expect(lines(say(f, { body: "```\ncode\n```", subject: "garden" }))).toEqual([block, many(manyMoments + 2)]);
      expect(lines(say(f, { body: "长".repeat(1600) }))).toEqual([long(1600), many(manyMoments + 3)]);
      // A reconstructed one, past the first reminded, is not reminded either.
      expect(lines(say(f, { source: "reconstructed", happenedAt: "2026-01-01" }))).toEqual([]);
      // Another conversation starts from none.
      f.session = f.begin("model-a", "other").session.id;
      expect(lines(say(f))).toEqual([]);
    }));

  it("follow the answer's subject sentence, and a duplicate gets none", () =>
    start((f) => {
      for (let i = 0; i < manyMoments; i++) say(f);
      const t = say(f, { body: "```\nx\n```", subject: "garden" });
      expect(t).toMatch(/^remembered as m_\w+ under a new subject, m_\w+\. If it is one you already have under another name, merge the two in your next round of reflection\.\n/);
      expect(lines(t)).toEqual([block, many(manyMoments + 1)]);
      const same = text(f.obj.answer({ tool: "remember", args: { sessionId: f.sess(), gist: `第${n}件`, body: "```\nx\n```" } }));
      expect(same).toMatch(/^already remembered as m_[a-z2-9]{8}$/);
    }));

  it("keep their count through a replay", () =>
    start((f) => {
      for (let i = 0; i < 3; i++) say(f);
      say(f, { source: "reconstructed", happenedAt: "2026-01-01" });
      const count = () => f.storage.sql.exec<{ wrote_n: number }>(`SELECT wrote_n FROM sessions WHERE id = ?`, f.sess()).one().wrote_n;
      expect(count()).toBe(3);
      const before = dump(f.st, f.storage);
      f.st.rebuild();
      expect(dump(f.st, f.storage)).toBe(before);
      expect(count()).toBe(3);
    }));

  it("are named in the access log by fixed words alone", async () => {
    const m = await createMemory();
    await setClock(m.name, t0);
    const c = new Client("new", m);
    const s = idIn(await c.ok("get_context", {}), "s_");
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      for (let i = 0; i < manyMoments; i++) await c.ok("remember", { session_id: s, gist: `zqx 第${i}件`, body: "zqxbody 正文" });
      await c.ok("remember", { session_id: s, gist: "zqx 代码", body: "```\nzqxcode\n```" });
      await c.ok("remember", { session_id: s, gist: "zqx 长", body: "长".repeat(1501) });
    } finally {
      spy.mockRestore();
    }
    const tools = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === "tool");
    expect(tools.map((l) => l.reminded)).toEqual([...Array<undefined>(manyMoments).fill(undefined), "block+many", "long+many"]);
    for (const l of lines) {
      expect(l).not.toContain("zqx");
      expect(l).not.toContain("长长");
    }
  });
});

// Recall by time: since and until, read in the session's zone, a date alone
// being the whole day; without a query a listing, newest first, that counts
// as nothing coming to mind. Memories hold made-up text; the tests look at
// ids, figures and the fixed strings written here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { nothingFound, nothingFoundShallow, nothingInSpan, nothingListed } from "../src/mcp/format";
import type { RecallArgs } from "../src/memory-object";
import { queryVectorOf } from "./embed-helpers";
import { t0 } from "./helpers";
import { Client, createMemory, idIn, setClock } from "./mcp-helpers";
import { recallBefore, shown } from "./recall-before";
import { type Fixture, ids, ok, start, startEmbedded } from "./service-helpers";

afterEach(() => vi.restoreAllMocks());

const unreadable = (field: string, s: string) =>
  `cannot read ${field} "${s}" as a date: write it like 2026-03-14 or 2026-03-14T09:30:00Z`;
const reversed = "since is after until: give a since that comes before until, or leave one out";

function zoned(f: Fixture, zone: string): string {
  return ok(f.obj.getContext({ model: "model-a", client: "test", timezone: zone })).session.id;
}

// past writes a memory of something that took place at when, read in the
// zone of the session.
function past(f: Fixture, sessionId: string, gist: string, when: string): string {
  return f.rememberWith({ sessionId, gist, body: "a body", source: "reconstructed", happenedAt: when });
}

function recall(f: Fixture, args: Partial<RecallArgs>): string[] {
  return ids(ok(f.obj.recall({ query: "", ...args })));
}

function events(f: Fixture): number {
  return f.st.counts().events;
}

describe("recall by time", () => {
  it("lists without a query, newest first, both ends whole days, in the session's zone", () =>
    start((f) => {
      const sh = zoned(f, "Asia/Shanghai");
      const utc = f.sess();
      const d13 = past(f, sh, "span d13", "2026-03-13T23:59:59.999");
      const d14a = past(f, sh, "span d14a", "2026-03-14T00:00:00");
      const d14b = past(f, sh, "span d14b", "2026-03-14T23:59:59.999");
      const d15 = past(f, sh, "span d15", "2026-03-15 00:00");
      const now = f.rememberWith({ sessionId: sh, gist: "span now", body: "a body" });

      // In Shanghai the 14th is 2026-03-13T16:00Z to 2026-03-14T16:00Z.
      expect(recall(f, { sessionId: sh, since: "2026-03-14", until: "2026-03-14" })).toEqual([d14b, d14a]);
      expect(recall(f, { sessionId: utc, since: "2026-03-14", until: "2026-03-14" })).toEqual([d15, d14b]);
      expect(recall(f, { sessionId: sh, since: "2026-03-15" })).toEqual([now, d15]);
      expect(recall(f, { sessionId: sh, until: "2026-03-13" })).toEqual([d13]);
      expect(recall(f, { sessionId: sh, until: " 2026-03-14 " })).toEqual([d14b, d14a, d13]);
      // A date and a time: that instant, at either end.
      expect(recall(f, { sessionId: sh, since: "2026-03-14 12:00", until: "2026-03-15T00:00:00" })).toEqual([d15, d14b]);
      expect(recall(f, { sessionId: sh, since: "2026-03-14T15:59:59.999Z", until: "2026-03-14T15:59:59.999Z" })).toEqual([d14b]);
      // Neither: the newest, up to the limit; blank is neither.
      expect(recall(f, { sessionId: sh })).toEqual([now, d15, d14b, d14a, d13]);
      expect(recall(f, { sessionId: sh, limit: 2 })).toEqual([now, d15]);
      expect(recall(f, { sessionId: sh, query: "  ", since: " ", until: "" })).toEqual([now, d15, d14b, d14a, d13]);
      // Without a session the memory's own zone: UTC here.
      expect(recall(f, { since: "2026-03-14", until: "2026-03-14" })).toEqual([d15, d14b]);
      expect(recall(f, { sessionId: sh, since: "2026-04-01", until: "2026-04-30" })).toEqual([]);
    }));

  it("lists what the recent list may show: not what was set aside or replaced", () =>
    start((f) => {
      const a = f.remember("listed one", "a body");
      const b = f.remember("listed two", "a body");
      const c = f.remember("listed three", "a body");
      ok(f.obj.amend({ sessionId: f.sess(), action: "retract", id: b }));
      const msg = ok(f.obj.amend({ sessionId: f.sess(), action: "correct", id: c, gist: "listed three, corrected" }));
      const c2 = /m_[a-z0-9]+/.exec(msg)![0];
      expect(recall(f, { sessionId: f.sess() })).toEqual([c2, a]);
      expect(recall(f, { sessionId: f.sess(), deep: true })).toEqual([c2, a]);
    }));

  it("searches with a query among the memories of the span alone, by keyword and by meaning", () =>
    startEmbedded(async (f) => {
      const sh = zoned(f, "Asia/Shanghai");
      const march = past(f, sh, "spanword with the cat", "2026-03-14T09:00:00");
      const april = past(f, sh, "spanword again", "2026-04-02T09:00:00");
      const kitten = f.rememberWith({ sessionId: sh, gist: "a kitten today", body: "a body" });
      await f.sync();
      const search = (query: string, since?: string, until?: string) =>
        ids(ok(f.obj.recall({ query, sessionId: sh, meaning: queryVectorOf(query), ...(since ? { since } : {}), ...(until ? { until } : {}) })));

      // Without a span, as before.
      const before = shown(recallBefore(f.st, "spanword", 0, false));
      expect(shown(ok(f.obj.recall({ query: "spanword", sessionId: sh })))).toEqual(before);
      expect(before.map((s) => s[0]).sort()).toEqual([march, april].sort());
      expect(search("spanword", "2026-03-14", "2026-03-14")).toEqual([march]);
      expect(search("spanword", "2026-03-15")).toEqual([april]);
      // By meaning alone: the kitten is left out by the span.
      expect(search("feline").sort()).toEqual([march, kitten].sort());
      expect(search("feline", undefined, "2026-03-31")).toEqual([march]);
      expect(search("feline", "2026-11-01")).toEqual([kitten]);
      expect(search("feline", "2026-05-01", "2026-05-31")).toEqual([]);
    }));

  it("keeps to the span before taking the best matches, so that matches outside it crowd nothing out", () =>
    startEmbedded(async (f) => {
      const sh = zoned(f, "Asia/Shanghai");
      // 25 matches now, each at least as good as the one of the span, which
      // comes last both in the keyword index's ranking and among the vectors.
      for (let i = 0; i < 25; i++) f.rememberWith({ sessionId: sh, gist: `spanword cat ${i}`, body: "short" });
      const march = past(f, sh, "spanword cat, and a much longer account of a day with many other words in it", "2026-03-14T09:00:00");
      await f.sync();
      const inMarch = { since: "2026-03-01", until: "2026-03-31", sessionId: sh };
      expect(ids(ok(f.obj.recall({ query: "spanword", ...inMarch })))).toEqual([march]);
      // By meaning alone ("feline" is no word of any memory).
      const byMeaning = ok(f.obj.recall({ query: "feline", meaning: queryVectorOf("feline"), ...inMarch }));
      expect(byMeaning.map((r) => [r.id, r.byKeyword, r.byMeaning])).toEqual([[march, false, true]]);
    }));

  it("refuses a since or until that is not a date, and a since after until", () =>
    start((f) => {
      const sh = zoned(f, "Asia/Shanghai");
      f.remember("something", "a body");
      for (const query of ["", "something"]) {
        const cases: [Partial<RecallArgs>, string][] = [
          [{ since: "yesterday" }, unreadable("since", "yesterday")],
          [{ until: "2026-02-30" }, unreadable("until", "2026-02-30")],
          [{ since: "2026/03/14" }, unreadable("since", "2026/03/14")],
          [{ since: "2026-03-15", until: "2026-03-14" }, reversed],
          [{ since: "2026-03-14T12:00:00", until: "2026-03-14T11:59:59" }, reversed],
        ];
        for (const [args, want] of cases) {
          expect(f.obj.recall({ query, sessionId: sh, ...args }), `${query} ${JSON.stringify(args)}`).toEqual({ invalid: want });
        }
        // One instant at both ends is a span.
        expect(f.obj.recall({ query, sessionId: sh, since: "2026-03-14T12:00:00", until: "2026-03-14T12:00:00" })).toEqual([]);
      }
    }));

  it("a listing writes no event and restarts no decay; a search kept to a span does both", () =>
    start((f) => {
      const m = f.remember("decaying thing", "a body");
      f.fill(5);
      const was = f.get(m);
      const n = events(f);
      expect(recall(f, { sessionId: f.sess(), limit: 20 })).toContain(m);
      expect(recall(f, { sessionId: f.sess(), since: "2026-11-01", limit: 20 })).toContain(m);
      expect(events(f)).toBe(n);
      const now = f.get(m);
      expect([now.recallCount, now.touchedOrd, now.strength, now.lastRecalledAt]).toEqual([was.recallCount, was.touchedOrd, was.strength, was.lastRecalledAt]);

      expect(ids(ok(f.obj.recall({ query: "decaying", since: "2026-11-01", sessionId: f.sess() })))).toEqual([m]);
      expect(events(f)).toBe(n + 1);
      const after = f.get(m);
      expect([after.recallCount, after.touchedOrd]).toEqual([was.recallCount + 1, f.lived()]);
    }));

  it("lists faded memories, and archived ones only with deep", () =>
    startEmbedded(async (f) => {
      const x = f.remember("will be archived", "a body");
      f.fill(17);
      const y = f.remember("will have faded", "a body");
      f.fill(14);
      expect([f.tier(x), f.tier(y)]).toEqual(["archived", "faded"]);
      await f.sync();
      expect(f.st.vectorRuns().fullAsked).toBe(false);
      const until = new Date(f.get(y).createdAt).toISOString();

      const plain = ok(f.obj.recall({ query: "", until, limit: 20, sessionId: f.sess() }));
      expect(plain[0]!.id).toBe(y);
      expect(plain[0]!.tier).toBe("faded");
      expect(ids(plain)).not.toContain(x);

      // Y, the 17 written between, and X; the oldest of those between are
      // archived too.
      const deep = ok(f.obj.recall({ query: "", until, limit: 20, deep: true, sessionId: f.sess() }));
      expect(deep).toHaveLength(19);
      expect(deep.at(-1)!.id).toBe(x);
      expect(deep.at(-1)!.tier).toBe("archived");
      const archived = deep.filter((r) => r.tier === "archived").length;
      expect(archived).toBeGreaterThan(1);
      expect(ids(plain)).toEqual(ids(deep.filter((r) => r.tier !== "archived")));
      expect(plain.every((r) => r.tier === "faded")).toBe(true);
      // Listed, it stays archived: nothing came to mind, and no vector is
      // asked for.
      expect(f.tier(x)).toBe("archived");
      expect(f.st.vectorRuns().fullAsked).toBe(false);
      // A deep search kept to the span reaches it, brings it back, and asks
      // for its vector.
      expect(ids(ok(f.obj.recall({ query: "archived", until, deep: true, sessionId: f.sess() })))).toEqual([x]);
      expect(f.st.vectorRuns().fullAsked).toBe(true);
    }));
});

describe("recall by time over MCP", () => {
  it("answers in the layout of a recall, names the zone, says when nothing is listed, and logs fixed words", async () => {
    const m = await createMemory();
    await setClock(m.name, t0);
    const c = new Client("new", m);
    expect(await c.ok("recall", {})).toBe(nothingListed + "; recall with deep=true also lists those that have left ordinary recall");
    expect(await c.ok("recall", { deep: true })).toBe(nothingListed);
    const s = idIn(await c.ok("get_context", { timezone: "Asia/Shanghai" }), "s_");
    const id = idIn(await c.ok("remember", {
      session_id: s, gist: "over mcp", body: "a body", source: "reconstructed", happened_at: "2026-03-14 00:30",
    }));
    const log = vi.spyOn(console, "log");
    const text = await c.ok("recall", { since: "2026-03-14", until: "2026-03-14", session_id: s });
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]!.startsWith(`[${id}] 2026-03-14 other: `)).toBe(true);
    expect(lines.slice(1)).toEqual(["time zone: Asia/Shanghai", ""]);
    // The same day in UTC ends before the memory.
    expect(await c.ok("recall", { since: "2026-03-14", until: "2026-03-14" }))
      .toBe(nothingInSpan + "; recall with deep=true also lists those that have left ordinary recall");
    expect(await c.ok("recall", { until: "2026-03-13", deep: true, session_id: s })).toBe(nothingInSpan);
    expect(await c.ok("recall", { query: "nothing-like-it", since: "2026-03-14", session_id: s })).toBe(nothingFoundShallow);
    expect(await c.ok("recall", { query: "nothing-like-it", deep: true })).toBe(nothingFound);
    expect(await c.tool("recall", { since: "soon", session_id: s })).toEqual({ text: unreadable("since", "soon"), isError: true });

    const tools = log.mock.calls.map((a) => JSON.parse(String(a[0])) as Record<string, unknown>).filter((l) => l.msg === "tool");
    expect(tools.map((l) => [l.outcome, l.recall_by, l.recall_parts, l.recall_span])).toEqual([
      ["ok", "time", 0, "both"],
      ["ok", "time", 0, "both"],
      ["ok", "time", 0, "until"],
      ["ok", "subject", 1, "since"],
      ["ok", "subject", 1, "none"],
      ["invalid", "time", 0, "since"],
    ]);
    for (const l of log.mock.calls) for (const w of ["over mcp", "nothing-like-it", "soon"]) expect(String(l[0])).not.toContain(w);
  });
});

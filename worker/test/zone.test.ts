// Time zones: written as the session's wall clock, shown in the session's
// zone, kept with the session, and the memory's default zone.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { serverSpeaks, writeUnasked } from "../src/mcp/format";
import { parseWhen } from "../src/memory/clean";
import type { Memory as MemoryObject } from "../src/memory-object";
import { formatDate, formatDateTime, instantOf, knownZone } from "../src/zone";
import { minute, t0 } from "./helpers";
import { Client, createMemory, idIn, setClock } from "./mcp-helpers";

const at = (iso: string): number => Date.parse(iso);

describe("zone arithmetic", () => {
  it("writes a date and time in a zone, with its offset at that instant", () => {
    expect(formatDateTime(t0, "UTC")).toBe("2026-11-11 08:00Z");
    expect(formatDateTime(t0, "Asia/Shanghai")).toBe("2026-11-11 16:00 +08:00");
    expect(formatDateTime(at("2026-07-01T12:00:00Z"), "America/New_York")).toBe("2026-07-01 08:00 -04:00");
    expect(formatDateTime(at("2026-11-11T12:00:00Z"), "America/New_York")).toBe("2026-11-11 07:00 -05:00");
    expect(formatDateTime(at("2026-01-15T12:00:00Z"), "Asia/Kolkata")).toBe("2026-01-15 17:30 +05:30");
    // Europe/London is on UTC in winter: written as Go writes a zero offset.
    expect(formatDateTime(at("2026-01-15T12:00:00Z"), "Europe/London")).toBe("2026-01-15 12:00Z");
    expect(formatDateTime(at("2026-07-15T12:00:00Z"), "Europe/London")).toBe("2026-07-15 13:00 +01:00");
    // A date is the date in the zone.
    expect(formatDate(at("2026-11-11T20:00:00Z"), "UTC")).toBe("2026-11-11");
    expect(formatDate(at("2026-11-11T20:00:00Z"), "Asia/Shanghai")).toBe("2026-11-12");
    expect(formatDate(at("2026-11-11T02:00:00Z"), "America/Los_Angeles")).toBe("2026-11-10");
  });

  it("reads a wall-clock time across daylight-saving changes", () => {
    const w = (y: number, mo: number, d: number, h: number, mi: number) => ({ year: y, month: mo, day: d, hour: h, minute: mi, second: 0, ms: 0 });
    expect(instantOf(w(2026, 7, 1, 8, 0), "America/New_York")).toBe(at("2026-07-01T12:00:00Z"));
    expect(instantOf(w(2026, 12, 1, 8, 0), "America/New_York")).toBe(at("2026-12-01T13:00:00Z"));
    // 02:30 on 8 March 2026 does not exist in New York: moved forward an hour.
    expect(instantOf(w(2026, 3, 8, 2, 30), "America/New_York")).toBe(at("2026-03-08T07:30:00Z"));
    // 01:30 on 1 November 2026 happens twice there: the earlier one.
    expect(instantOf(w(2026, 11, 1, 1, 30), "America/New_York")).toBe(at("2026-11-01T05:30:00Z"));
    expect(instantOf(w(2026, 3, 14, 0, 0), "Asia/Shanghai")).toBe(at("2026-03-13T16:00:00Z"));
  });

  it("parses happened_at in a zone unless it carries its own", () => {
    expect(parseWhen("2026-03-14")).toBe(at("2026-03-14T00:00:00Z"));
    expect(parseWhen("2026-03-14", "Asia/Shanghai")).toBe(at("2026-03-13T16:00:00Z"));
    expect(parseWhen("2026-03-08 02:30", "America/New_York")).toBe(at("2026-03-08T07:30:00Z"));
    expect(parseWhen("2026-07-04T09:00:00", "America/New_York")).toBe(at("2026-07-04T13:00:00Z"));
    expect(parseWhen("2026-03-14T09:30:00Z", "Asia/Shanghai")).toBe(at("2026-03-14T09:30:00Z"));
    expect(parseWhen("2026-03-14T09:30:00+02:00", "Asia/Shanghai")).toBe(at("2026-03-14T07:30:00Z"));
  });

  it("knows zones by name only", () => {
    expect(knownZone("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(knownZone("asia/shanghai")).toBe("Asia/Shanghai");
    expect(knownZone("Mars/Olympus")).toBeUndefined();
    expect(knownZone("+08:00")).toBeUndefined();
    expect(knownZone("")).toBeUndefined();
  });
});

describe("time zones through the tools", () => {
  it("keeps the zone a session reports and shows its times in it", async () => {
    const m = await createMemory();
    await setClock(m.name, t0);
    const c = new Client("new", m);
    const ctx = await c.ok("get_context", { timezone: "Asia/Shanghai" });
    const s = idIn(ctx, "s_");
    expect(ctx).toBe(`session: ${s}\nnow: 2026-11-11 16:00 +08:00 (Asia/Shanghai)\nNo memories yet. This is where it starts.\n${serverSpeaks}${writeUnasked}`);
    const id = idIn(await c.ok("remember", { session_id: s, gist: "zone marker one", body: "b" }));
    // A date alone in that zone: Shanghai is a day ahead at 20:00 UTC.
    await setClock(m.name, at("2026-11-11T20:00:00Z"));
    const late = idIn(await c.ok("remember", { session_id: s, gist: "zone marker two", body: "b" }));
    const recalled = await c.ok("recall", { query: "zone marker", session_id: s });
    expect(recalled).toContain(`[${late}] 2026-11-12 other: zone marker two\n`);
    expect(recalled).toContain(`[${id}] 2026-11-11 other: zone marker one\n`);
    expect(recalled.endsWith("time zone: Asia/Shanghai\n")).toBe(true);
    const full = await c.ok("expand", { ids: [late], session_id: s });
    expect(full.startsWith(`[${late}] 2026-11-12 04:00 +08:00 · other · lived`)).toBe(true);
    expect(full.endsWith("time zone: Asia/Shanghai\n")).toBe(true);
    // A later reading is dated in the zone too.
    const batch = idIn(await c.ok("reflect", { session_id: s }), "b_");
    const rd = idIn(await c.ok("reflect", {
      session_id: s, batch, entries: [{ kind: "reading", ref: late, gist: "read again" }], pass: [id, late],
    }));
    expect(await c.ok("expand", { ids: [late], session_id: s })).toContain(`\nlater reading [${rd}] 2026-11-12: read again\n`);
    // Without a session the memory's default, UTC, is used.
    const plain = await c.ok("expand", { ids: [late] });
    expect(plain.startsWith(`[${late}] 2026-11-11 20:00Z · other`)).toBe(true);
    expect(plain.endsWith("time zone: UTC\n")).toBe(true);
    // An id that names no session is no session.
    expect((await c.ok("recall", { query: "zone marker", session_id: "s_none" })).endsWith("time zone: UTC\n")).toBe(true);

    // The zone is in the session event and survives a replay.
    await runInDurableObject(env.MEMORY.getByName(m.name), (obj: MemoryObject, state) => {
      const payload = state.storage.sql.exec<{ payload: string }>(`SELECT payload FROM events WHERE kind = 'session'`).one().payload;
      expect(JSON.parse(payload)).toEqual({ id: s, client: "test-client", tz: "Asia/Shanghai" });
      obj.store.rebuild();
      expect(obj.store.session(s)?.tz).toBe("Asia/Shanghai");
    });
  });

  it("shows a zone with daylight saving at the offset of each instant", async () => {
    const m = await createMemory();
    await setClock(m.name, at("2026-07-01T12:00:00Z"));
    const c = new Client("old", m);
    await c.connect();
    const ctx = await c.ok("get_context", { timezone: "America/New_York" });
    expect(ctx).toContain("\nnow: 2026-07-01 08:00 -04:00 (America/New_York)\n");
    const s = idIn(ctx, "s_");
    const summer = idIn(await c.ok("remember", { session_id: s, gist: "summer", body: "b" }));
    await setClock(m.name, at("2026-11-11T12:00:00Z"));
    const winter = idIn(await c.ok("remember", { session_id: s, gist: "winter", body: "b" }));
    const full = await c.ok("expand", { ids: [summer, winter], session_id: s });
    expect(full).toContain(`[${summer}] 2026-07-01 08:00 -04:00 · other`);
    expect(full).toContain(`[${winter}] 2026-11-11 07:00 -05:00 · other`);
  });

  it("reads happened_at as the session's wall clock, then checks it is not in the future", async () => {
    const m = await createMemory();
    await setClock(m.name, t0); // 2026-11-11 08:00 UTC
    const c = new Client("new", m);
    const ny = idIn(await c.ok("get_context", { timezone: "America/New_York" }), "s_");
    const sh = idIn(await c.ok("get_context", { timezone: "Asia/Shanghai" }), "s_");
    const kiri = idIn(await c.ok("get_context", { timezone: "Pacific/Kiritimati" }), "s_"); // UTC+14
    const utc = idIn(await c.ok("get_context", {}), "s_");
    const rec = (s: string, happened: string, gist: string) =>
      c.tool("remember", { session_id: s, gist, body: "b", source: "reconstructed", happened_at: happened });

    const gap = idIn((await rec(ny, "2026-03-08 02:30", "gap")).text);
    const day = idIn((await rec(sh, "2026-03-14", "day")).text);
    const zulu = idIn((await rec(sh, "2026-03-14T09:30:00Z", "zulu")).text);
    // 21:00 on 11 November at UTC+14 is 07:00 UTC: an hour ago.
    const east = idIn((await rec(kiri, "2026-11-11 21:00", "east")).text);
    expect(await rec(utc, "2026-11-11 21:00", "late")).toEqual({ text: "happened_at is in the future", isError: true });
    expect(await rec(sh, "2026-11-11 16:30", "soon")).toEqual({ text: "happened_at is in the future", isError: true });

    await runInDurableObject(env.MEMORY.getByName(m.name), (obj: MemoryObject) => {
      const created = Object.fromEntries(obj.store.get([gap, day, zulu, east]).map((x) => [x.id, x.createdAt]));
      expect(created).toEqual({
        [gap]: at("2026-03-08T07:30:00Z"),
        [day]: at("2026-03-13T16:00:00Z"),
        [zulu]: at("2026-03-14T09:30:00Z"),
        [east]: at("2026-11-11T07:00:00Z"),
      });
    });
    const shown = await c.ok("expand", { ids: [day, gap], session_id: sh });
    expect(shown).toContain(`[${day}] 2026-03-14 00:00 +08:00 · other · reconstructed`);
    expect(shown).toContain(`[${gap}] 2026-03-08 15:30 +08:00 · other · reconstructed`);
    const inUTC = await c.ok("expand", { ids: [day], session_id: utc });
    expect(inUTC).toContain(`[${day}] 2026-03-13 16:00Z · other · reconstructed`);
  });

  it("does not keep a zone it does not know, and says so", async () => {
    const m = await createMemory();
    await setClock(m.name, t0);
    const c = new Client("new", m);
    for (const bad of ["Mars/Olympus", "+08:00"]) {
      const ctx = await c.ok("get_context", { timezone: bad });
      const s = idIn(ctx, "s_");
      expect(ctx.split("\n").slice(1, 3)).toEqual([
        "now: 2026-11-11 08:00Z (UTC)",
        `The time zone ${JSON.stringify(bad)} was not recognised and was not kept; times are shown in UTC.`,
      ]);
      await runInDurableObject(env.MEMORY.getByName(m.name), (obj: MemoryObject, state) => {
        expect(obj.store.session(s)?.tz).toBe("");
        const p = state.storage.sql.exec<{ payload: string }>(`SELECT payload FROM events WHERE kind = 'session' ORDER BY seq DESC LIMIT 1`).one().payload;
        expect(JSON.parse(p)).not.toHaveProperty("tz");
      });
    }
    // A known zone in another case is kept under the runtime's name.
    const ctx = await c.ok("get_context", { timezone: " asia/shanghai " });
    expect(ctx).toContain("\nnow: 2026-11-11 16:00 +08:00 (Asia/Shanghai)\n");
  });

  it("has a default zone, UTC unless set, for calls whose session reported none", async () => {
    const m = await createMemory();
    await setClock(m.name, t0);
    const stub = env.MEMORY.getByName(m.name);
    expect(await stub.timeZone()).toBe("UTC");
    expect(await stub.setTimeZone("Mars/Olympus")).toEqual({
      invalid: `unknown time zone "Mars/Olympus": give an IANA name such as Asia/Shanghai`,
    });
    expect(await stub.setTimeZone("europe/berlin")).toBe("Europe/Berlin");
    expect(await stub.timeZone()).toBe("Europe/Berlin");
    const c = new Client("new", m);
    const ctx = await c.ok("get_context", {});
    expect(ctx).toContain("\nnow: 2026-11-11 09:00 +01:00 (Europe/Berlin)\n");
    const s = idIn(ctx, "s_");
    const id = idIn(await c.ok("remember", { session_id: s, gist: "default zone", body: "b" }));
    expect((await c.ok("recall", { query: "default zone" })).endsWith("time zone: Europe/Berlin\n")).toBe(true);
    const sh = idIn(await c.ok("get_context", { timezone: "Asia/Shanghai" }), "s_");
    expect((await c.ok("expand", { ids: [id], session_id: sh })).endsWith("time zone: Asia/Shanghai\n")).toBe(true);
    // A reconstructed date from a session without a zone is read in the default.
    const r = idIn(await c.ok("remember", { session_id: s, gist: "berlin day", body: "b", source: "reconstructed", happened_at: "2026-03-14" }));
    await runInDurableObject(stub, (obj: MemoryObject) => {
      expect(obj.store.get([r])[0]!.createdAt).toBe(at("2026-03-13T23:00:00Z"));
    });
  });

  it("shows the dates of the restore note and other sessions in the zone", async () => {
    const m = await createMemory();
    await setClock(m.name, t0);
    await runInDurableObject(env.MEMORY.getByName(m.name), (_obj: MemoryObject, state) => {
      // A restore late on 10 November UTC is the 11th in Shanghai.
      state.storage.sql.exec(
        `INSERT INTO events(at, kind, payload) VALUES(?, 'restore', ?)`,
        at("2026-11-10T20:00:00Z"), JSON.stringify({ from: "i_x", exported_at: at("2026-11-01T18:00:00Z"), events: 0 }),
      );
      _obj.store.rebuild();
    });
    const c = new Client("new", m);
    const ctx = await c.ok("get_context", { timezone: "Asia/Shanghai" });
    expect(ctx).toContain("This memory was brought back on 2026-11-11 from a backup made on 2026-11-02.");
    await setClock(m.name, t0 + 5 * minute);
    const ctx2 = await c.ok("get_context", {});
    expect(ctx2).toContain("This memory was brought back on 2026-11-10 from a backup made on 2026-11-01.");
    expect(ctx2).toMatch(/last active 5 min ago\n/);
  });
});

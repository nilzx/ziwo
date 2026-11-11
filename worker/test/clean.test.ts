// The checks on input, against what the Go build does. The cases of
// parseWhen, goQuote and trimSpace were produced by running Go's ParseWhen,
// %q and strings.TrimSpace on the same strings (go1.27.4).

import { describe, expect, it } from "vitest";
import { clip, goQuote, parseWhen, runeCount, trimSpace } from "../src/memory/clean";
import type { RememberArgs } from "../src/memory-object";
import { minute, t0 } from "./helpers";
import { isInvalid, start } from "./service-helpers";

const whenCases: [string, number | "zero" | "error"][] = [
  ["2026-03-14", 1773446400000],
  [" 2026-03-14\n", 1773446400000],
  ["2026-03-14T09:30:00Z", 1773480600000],
  ["2026-03-14T09:30:00", 1773480600000],
  ["2026-03-14 09:30:00", 1773480600000],
  ["2026-03-14 09:30", 1773480600000],
  ["2026-03-14T9:30:00Z", 1773480600000],
  ["2026-03-14 9:30", 1773480600000],
  ["2026-03-14   09:30", 1773480600000],
  ["2026-03-14T09:30:00.123456789Z", 1773480600123],
  ["2026-03-14T09:30:00,5+02:00", 1773473400500],
  ["2026-03-14T09:30:00.9999-05:30", 1773500400999],
  ["2026-03-14 09:30:00.25", 1773480600250],
  ["2026-03-14T09:30:00+24:00", 1773394200000],
  ["2026-03-14T09:30:00+24:60", 1773390600000],
  ["2026-03-14T09:30:00+25:00", "error"],
  ["2026-03-14T09:30:00+05", "error"],
  ["2026-03-14T09:30:00z", "error"],
  ["2026-02-29", "error"],
  ["2024-02-29", 1709164800000],
  ["2000-02-29", 951782400000],
  ["1900-02-29", "error"],
  ["2026-13-01", "error"],
  ["2026-00-10", "error"],
  ["2026-04-31", "error"],
  ["2026-04-00", "error"],
  ["2026-03-14T24:00:00Z", "error"],
  ["2026-03-14T23:60:00Z", "error"],
  ["2026-03-14T23:59:60Z", "error"],
  ["0001-01-01", "zero"],
  ["0001-01-01T00:00:00Z", "zero"],
  ["0001-01-01T01:00:00+01:00", "zero"],
  ["0001-01-01T00:00:00.0000001Z", -62135596800000],
  ["0099-06-15", -59028739200000],
  ["1969-12-31T23:59:59.999Z", -1],
  ["1970-01-01", 0],
  ["2026-3-14", "error"],
  ["26-03-14", "error"],
  ["2026-03-14T09:30Z", "error"],
  ["2026-03-14 09:30.5", "error"],
  ["2026/03/14", "error"],
  ["", "error"],
  ["yesterday", "error"],
  ["2026-03-14T09:30:00Z extra", "error"],
  ["\u00a02026-03-14\u3000", 1773446400000],
  ["\ufeff2026-03-14", "error"],
  ["\u00852026-03-14", 1773446400000],
  ["2026-03-14T123:00:00Z", "error"],
  ["\uff12\uff10\uff12\uff16-03-14", "error"],
  ["2026-03-14 \t09:30", "error"],
  ["9999-12-31T23:59:59Z", 253402300799000],
  ["2026-03-14T09:30:00.Z", "error"],
  ["2026-03-14T09:30:00-00:00", 1773480600000],
];
const quoteCases: [string, string][] = [
  ["s_nope", "\"s_nope\""],
  ["a\"b\\c", "\"a\\\"b\\\\c\""],
  ["tab\there", "\"tab\\there\""],
  ["nl\n", "\"nl\\n\""],
  ["\u0007\u007f\u0001", "\"\\a\\x7f\\x01\""],
  ["\u4e2d\u6587", "\"\u4e2d\u6587\""],
  ["\u00a0nbsp", "\"\\u00a0nbsp\""],
  ["\u200bzw", "\"\\u200bzw\""],
  ["\u2028ls", "\"\\u2028ls\""],
  ["\ud83d\ude00", "\"\ud83d\ude00\""],
  ["\udb40\udc01", "\"\\U000e0001\""],
  ["\ufeffbom", "\"\\ufeffbom\""],
  ["\u0085nel", "\"\\u0085nel\""],
  ["\u00e9", "\"\u00e9\""],
];
const trimCases: [string, string][] = [
  [" a ", "a"],
  ["\u00a0a\u3000", "a"],
  ["\ufeffa\ufeff", "\ufeffa\ufeff"],
  ["\u0085a\u0085", "a"],
  ["\u200ba", "\u200ba"],
  ["\t\n\u000b\f\r a \u2028\u2029", "a"],
  ["\u1680a\u205f", "a"],
  ["\u180ea", "\u180ea"],
];

describe("clean", () => {
  it("parseWhen reads what Go's ParseWhen reads", () => {
    for (const [input, want] of whenCases) {
      if (want === "error") {
        expect(() => parseWhen(input), JSON.stringify(input)).toThrow(
          `cannot read ${goQuote(trimSpace(input))} as a date: write it like 2026-03-14 or 2026-03-14T09:30:00Z`,
        );
      } else {
        expect(parseWhen(input), JSON.stringify(input)).toBe(want === "zero" ? undefined : want);
      }
    }
  });

  it("goQuote is Go's %q", () => {
    for (const [input, want] of quoteCases) expect(goQuote(input), JSON.stringify(input)).toBe(want);
    // A lone surrogate stands for invalid UTF-8, which Go's JSON decoder makes U+FFFD.
    expect(goQuote("a\ud800b")).toBe('"a�b"');
  });

  it("trimSpace is strings.TrimSpace", () => {
    for (const [input, want] of trimCases) expect(trimSpace(input), JSON.stringify(input)).toBe(want);
  });

  it("counts and clips by code point", () => {
    expect(runeCount("a字😀")).toBe(3);
    expect(clip("😀😀😀", 2)).toBe("😀😀");
    expect(clip("abc", 3)).toBe("abc");
  });

  it("checks the date a memory took place", () =>
    start((f) => {
      const sess = f.sess();
      const write = (args: RememberArgs) => f.obj.remember({ sessionId: sess, gist: "g", body: "b", ...args });
      expect(write({ happenedAt: "2026-03-14" })).toEqual({
        invalid: `happened_at goes with source "reconstructed" only: a memory written as it happens is dated now`,
      });
      for (const happenedAt of [undefined, "", "  ", "0001-01-01"]) {
        expect(write({ source: "reconstructed", happenedAt }), JSON.stringify(happenedAt)).toEqual({
          invalid: `happened_at is required with source "reconstructed": the day it took place, as the record shows it`,
        });
      }
      expect(write({ source: "reconstructed", happenedAt: "last spring" })).toEqual({
        invalid: `cannot read "last spring" as a date: write it like 2026-03-14 or 2026-03-14T09:30:00Z`,
      });
      // A minute's grace for clocks that disagree.
      const iso = (ms: number) => new Date(ms).toISOString();
      expect(write({ source: "reconstructed", happenedAt: iso(f.clock + minute + 1000) })).toEqual({ invalid: "happened_at is in the future" });
      const ok = write({ source: "reconstructed", happenedAt: iso(f.clock + minute) });
      expect(isInvalid(ok)).toBe(false);
      const m = f.get((ok as { id: string }).id);
      expect([m.createdAt, m.writtenAt, m.source]).toEqual([t0 + minute, t0, "reconstructed"]);
      // A reconstructed memory does not advance the clock.
      expect(f.lived()).toBe(0);
    }));

  it("checks the other fields", () =>
    start((f) => {
      const sess = f.sess();
      const write = (args: RememberArgs) => f.obj.remember({ sessionId: sess, gist: "g", body: "b", ...args });
      const long = (n: number) => "字".repeat(n);
      expect(write({ outcome: long(1001) })).toEqual({ invalid: "outcome is 1001 characters, the limit is 1000" });
      expect(write({ feeling: long(1001) })).toEqual({ invalid: "feeling is 1001 characters, the limit is 1000" });
      expect(write({ pointer: long(501) })).toEqual({
        invalid: "pointer is 501 characters, the limit is 500: give a location, not the content",
      });
      expect(write({ sessionId: "s_\u0007中" })).toEqual({
        invalid: `unknown session_id "s_\\a中": call get_context and pass the session id it returns`,
      });
      // Names are trimmed, clipped to 80 characters and counted after
      // duplicates are dropped.
      const many = Array.from({ length: 20 }, (_, i) => ` n${i % 16} `);
      const r = write({ gist: "people", people: [...many, long(90)], feeling: " 轻松 ", intensity: 0.5, outcome: " o ", lesson: " l ", pointer: " p " });
      expect(isInvalid(r), JSON.stringify(r)).toBe(true); // 17 distinct names
      const r2 = write({ gist: "people", people: [...many, long(90) + "x", long(80)], feeling: " 轻松 ", intensity: 0.5, outcome: " o ", lesson: " l ", pointer: " p " });
      expect(isInvalid(r2), JSON.stringify(r2)).toBe(true);
      const r3 = write({ gist: "people", people: [...many.slice(0, 15), long(90), long(80)], feeling: " 轻松 ", intensity: 0.5, outcome: " o ", lesson: " l ", pointer: " p " });
      expect(isInvalid(r3), JSON.stringify(r3)).toBe(false);
      const m = f.get((r3 as { id: string }).id);
      expect(m.people).toEqual([...many.slice(0, 15).map((p) => p.trim()), long(80)]);
      expect([m.feeling, m.intensity, m.outcome, m.lesson, m.pointer]).toEqual(["轻松", 0.5, "o", "l", "p"]);
    }));
});

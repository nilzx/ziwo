// Port of TestMatchQuery in internal/store/store_test.go.

import { expect, it } from "vitest";
import { covered, matchQuery, searchTerms } from "../src/store/segment";

it("MatchQuery", () => {
  const cases: [string, string][] = [
    ["", ""],
    ["?!，。", ""],
    ["猫", `"猫"`],
    ["记忆系统", `"记 忆" OR "忆 系" OR "系 统"`],
    ["Go SDK", `"go" OR "sdk"`],
    // Go keeps 写的, or and not; here what says nothing is left out when
    // the search has something else (see the next test).
    ["用Go写的", `"用" OR "go"`],
    [`"quoted" OR NOT`, `"quoted"`],
    ["记忆 记忆", `"记 忆"`],
  ];
  for (const [input, want] of cases) expect(matchQuery(input), input).toBe(want);
});

it("leaves out what says nothing, unless the search has nothing else", () => {
  const cases: [string, string][] = [
    ["beginner pieces for a string instrument", `"beginner" OR "pieces" OR "string" OR "instrument"`],
    ["The release went wrong and we reverted it", `"release" OR "went" OR "wrong" OR "reverted"`],
    ["内存占用一直上涨的问题", `"内 存" OR "存 占" OR "占 用" OR "用 一" OR "一 直" OR "直 上" OR "上 涨" OR "问 题"`],
    // Nothing else to go on: the search is made as written.
    ["我们的猫", `"我 们" OR "们 的" OR "的 猫"`],
    ["to be or not to be", `"to" OR "be" OR "or" OR "not"`],
    ["我的", `"我 的"`],
    ["的", `"的"`],
    // Case is folded before a word is looked up.
    ["THE Proxy", `"proxy"`],
  ];
  for (const [input, want] of cases) expect(matchQuery(input), input).toBe(want);
  // The limit on terms counts what is searched, not what was left out.
  const many = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" the ");
  expect(matchQuery(many).split(" OR ")).toHaveLength(48);
  expect(matchQuery(many)).not.toContain(`"the"`);
});

it("counts the terms of a search that a text holds, as the index matches them", () => {
  const terms = searchTerms("Proxy 记忆系统 release");
  expect(terms).toEqual(["proxy", "记 忆", "忆 系", "系 统", "release"]);
  expect(covered(terms, "The PROXY dropped. 这个记忆系统很好。")).toBe(4);
  expect(covered(terms, "proxying releases")).toBe(0); // a word is matched whole
  expect(covered(terms, "记,忆")).toBe(1); // what stands between two characters is not a token
  expect(covered(terms, "系 统 记")).toBe(1);
  expect(covered(terms, "")).toBe(0);
  expect(covered([], "anything")).toBe(0);
  expect(covered(searchTerms("猫"), "一只猫")).toBe(1);
});

// Port of TestMatchQuery in internal/store/store_test.go.

import { expect, it } from "vitest";
import { matchQuery } from "../src/store/segment";

it("MatchQuery", () => {
  const cases: [string, string][] = [
    ["", ""],
    ["?!，。", ""],
    ["猫", `"猫"`],
    ["记忆系统", `"记 忆" OR "忆 系" OR "系 统"`],
    ["Go SDK", `"go" OR "sdk"`],
    ["用Go写的", `"用" OR "go" OR "写 的"`],
    [`"quoted" OR NOT`, `"quoted" OR "or" OR "not"`],
    ["记忆 记忆", `"记 忆"`],
  ];
  for (const [input, want] of cases) expect(matchQuery(input), input).toBe(want);
});

import { describe, expect, it } from "vitest";
import {
  expandRegexReplacement,
  preserveReplacementCase,
  replacementForMatch,
  unquoteReplacement,
} from "./replacement";

describe("find replacement", () => {
  it("unquotes control characters", () => {
    expect(unquoteReplacement("a\\nb\\tc\\\\d")).toBe("a\nb\tc\\d");
  });

  it("uses the longest valid capture group reference", () => {
    const twoGroups = /(.)(.)/.exec("ab");
    const tenGroups = /(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)/.exec("abcdefghij");
    if (!twoGroups || !tenGroups) throw new Error("Expected regex matches");
    expect(expandRegexReplacement("$10", twoGroups)).toBe("a0");
    expect(expandRegexReplacement("$10", tenGroups)).toBe("j");
    expect(expandRegexReplacement("$$-$&", twoGroups)).toBe("$-ab");
  });

  it("preserves common casing styles", () => {
    expect(preserveReplacementCase("WORD", "value")).toBe("VALUE");
    expect(preserveReplacementCase("word", "VALUE")).toBe("value");
    expect(preserveReplacementCase("Word", "value")).toBe("Value");
    expect(preserveReplacementCase("ONE_TWO", "next_value")).toBe("NEXT_VALUE");
  });

  it("expands captures before preserving case", () => {
    const match = /(hello)/i.exec("HELLO");
    if (!match) throw new Error("Expected regex match");
    expect(
      replacementForMatch({
        replacement: "$1 world",
        source: "HELLO",
        regexpMatch: match,
        preserveCase: true,
      }),
    ).toBe("HELLO WORLD");
  });
});

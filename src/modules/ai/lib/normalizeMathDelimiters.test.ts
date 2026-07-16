import { normalizeMathDelimiters } from "@/modules/ai/lib/normalizeMathDelimiters";
import { describe, expect, it } from "vitest";

describe("normalizeMathDelimiters", () => {
  it("converts TeX delimiters while preserving line breaks", () => {
    const source = "inline \\(x^2\\)\n\\[\ny = x^2\n\\]";

    expect(normalizeMathDelimiters(source)).toBe(
      "inline $x^2$\n$$\ny = x^2\n$$",
    );
  });

  it("leaves inline code and fenced code unchanged", () => {
    const source =
      "`\\(inline code\\)`\n\n```typescript\n\\[fenced code\\]\n```";

    expect(normalizeMathDelimiters(source)).toBe(source);
  });

  it("protects the rest of an unterminated fenced block", () => {
    const source = "```\n\\(still code\\)";

    expect(normalizeMathDelimiters(source)).toBe(source);
  });
});

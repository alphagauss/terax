import { describe, expect, it } from "vitest";

import { isDiagramLanguage } from "./chat-code";

describe("isDiagramLanguage", () => {
  it("recognizes Mermaid fences case-insensitively", () => {
    expect(isDiagramLanguage("mermaid")).toBe(true);
    expect(isDiagramLanguage("MERMAID")).toBe(true);
  });

  it("does not classify regular code fences as diagrams", () => {
    expect(isDiagramLanguage("typescript")).toBe(false);
    expect(isDiagramLanguage(null)).toBe(false);
  });
});

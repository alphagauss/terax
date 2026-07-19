import { describe, expect, it } from "vitest";
import { shouldAutoFillGitHistory } from "./GitHistoryPane";

describe("Git History pagination", () => {
  it("does not auto-fill a hidden retained view", () => {
    expect(
      shouldAutoFillGitHistory({
        visible: false,
        loadStatus: "idle",
        endReached: false,
        activeSearch: "",
        commitCount: 30,
        scrollable: 0,
      }),
    ).toBe(false);
  });

  it("auto-fills a visible viewport that is not scrollable", () => {
    expect(
      shouldAutoFillGitHistory({
        visible: true,
        loadStatus: "idle",
        endReached: false,
        activeSearch: "",
        commitCount: 30,
        scrollable: 0,
      }),
    ).toBe(true);
  });
});

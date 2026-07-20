import { describe, expect, it } from "vitest";
import {
  shouldAutoFillGitHistory,
  shouldContinueGitHistorySearch,
} from "./GitHistoryPane";

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

  it("continues loading while a visible history search is incomplete", () => {
    expect(
      shouldContinueGitHistorySearch({
        visible: true,
        loadStatus: "idle",
        endReached: false,
        activeSearch: "target",
      }),
    ).toBe(true);
  });

  it("stops search pagination when the query clears or history ends", () => {
    expect(
      shouldContinueGitHistorySearch({
        visible: true,
        loadStatus: "idle",
        endReached: false,
        activeSearch: "",
      }),
    ).toBe(false);
    expect(
      shouldContinueGitHistorySearch({
        visible: true,
        loadStatus: "idle",
        endReached: true,
        activeSearch: "target",
      }),
    ).toBe(false);
  });
});

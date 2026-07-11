import { describe, expect, it } from "vitest";
import { ancestorDirs } from "./useFileTree";

describe("ancestorDirs", () => {
  it("returns the directories that must be expanded to reveal a file", () => {
    expect(ancestorDirs("/workspace", "/workspace/src/app/main.ts")).toEqual([
      "/workspace/src",
      "/workspace/src/app",
    ]);
  });

  it("does not reveal paths outside the current root", () => {
    expect(ancestorDirs("/workspace", "/other/main.ts")).toEqual([]);
  });
});

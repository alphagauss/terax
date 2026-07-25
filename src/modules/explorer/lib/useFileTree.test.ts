/**
 * 本文件验证资源管理器文件树的纯路径规则。
 * 锁定路径展开计算以及删除任务父子范围的互斥判断。
 */

import { describe, expect, it } from "vitest";
import {
  ancestorDirs,
  isPathDeleting,
  overlapsDeletingPath,
} from "./useFileTree";

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

describe("deleting paths", () => {
  const deleting = new Set(["/workspace/cache"]);

  it("marks the target and all descendants as deleting", () => {
    expect(isPathDeleting("/workspace/cache", deleting)).toBe(true);
    expect(isPathDeleting("/workspace/cache/nested/file", deleting)).toBe(true);
    expect(isPathDeleting("/workspace/cache-other", deleting)).toBe(false);
  });

  it("blocks concurrent deletion of overlapping parent or child paths", () => {
    expect(overlapsDeletingPath("/workspace/cache/nested", deleting)).toBe(
      true,
    );
    expect(overlapsDeletingPath("/workspace", deleting)).toBe(true);
    expect(overlapsDeletingPath("/workspace/src", deleting)).toBe(false);
  });
});

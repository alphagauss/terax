/**
 * 本文件测试资源管理器 Git 状态的主题语义色映射。
 * 锁定组件不直接依赖具体颜色值的边界。
 */

import { describe, expect, it } from "vitest";
import { explorerGitTextClass } from "./gitStatusColor";

describe("explorerGitTextClass", () => {
  it.each([
    ["M", "text-git-modified"],
    ["A", "text-git-added"],
    ["U", "text-git-untracked"],
    ["R", "text-git-renamed"],
    ["D", "text-git-deleted"],
  ] as const)("maps %s to its semantic theme color", (code, classes) => {
    expect(explorerGitTextClass(code)).toBe(classes);
  });
});

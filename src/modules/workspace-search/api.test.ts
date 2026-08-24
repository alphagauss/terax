/**
 * 本文件测试工作区内容搜索的前端 IPC 请求边界。
 * 锁定搜索面板与 AI grep 共用的 command、默认筛选数组和当前工作区环境注入。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  workspace: { kind: "wsl", distro: "Ubuntu" } as const,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => mocks.workspace,
}));

import { cancelContentSearch, searchContent } from "./api";

describe("workspace content search API", () => {
  beforeEach(() => mocks.invoke.mockReset());

  it("uses the unified command and injects workspace defaults", async () => {
    mocks.invoke.mockResolvedValue({
      hits: [],
      truncated: false,
      filesScanned: 0,
    });

    await searchContent({
      root: "/repo",
      pattern: "needle",
      syntax: "literal",
      caseMode: "insensitive",
      wholeWord: true,
    });

    expect(mocks.invoke).toHaveBeenCalledWith("fs_content_search", {
      request: {
        root: "/repo",
        pattern: "needle",
        syntax: "literal",
        caseMode: "insensitive",
        wholeWord: true,
        includes: [],
        excludes: [],
        workspace: mocks.workspace,
      },
    });
  });

  it("cancels through an empty interactive request on the same command", async () => {
    mocks.invoke.mockResolvedValue({
      hits: [],
      truncated: false,
      filesScanned: 0,
    });

    await cancelContentSearch("/repo");

    expect(mocks.invoke).toHaveBeenCalledWith(
      "fs_content_search",
      expect.objectContaining({
        request: expect.objectContaining({
          root: "/repo",
          pattern: "",
          cancelPrevious: true,
        }),
      }),
    );
  });
});

/**
 * 本文件测试 Explorer 目录缓存的隔离和刷新语义。
 * 重点锁定环境、路径和显示选项不会互相复用错误的目录列表。
 */

import {
  readCachedDirectory,
  resetDirectoryCacheForTests,
  writeCachedDirectory,
} from "@/modules/explorer/lib/directoryCache";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform", () => ({ IS_WINDOWS: true }));

const localInput = {
  workspace: { kind: "local" } as const,
  path: "C:\\Work\\Project",
  showHidden: false,
  gitDecorations: true,
};

describe("directory cache", () => {
  beforeEach(() => resetDirectoryCacheForTests());

  it("规范化同一 Local Windows 路径并返回最近结果", () => {
    writeCachedDirectory(localInput, {
      entries: [
        {
          name: "src",
          kind: "dir",
          size: 0,
          mtime: 1,
          gitignored: false,
        },
      ],
    });

    const cached = readCachedDirectory({
      ...localInput,
      path: "c:/work/project",
    });
    expect(cached?.entries[0]?.name).toBe("src");
  });

  it("隔离 Workspace 和目录显示选项", () => {
    writeCachedDirectory(localInput, {
      entries: [],
    });

    expect(
      readCachedDirectory({
        ...localInput,
        workspace: { kind: "ssh", profileId: "server" },
      }),
    ).toBeNull();
    expect(readCachedDirectory({ ...localInput, showHidden: true })).toBeNull();
    expect(
      readCachedDirectory({ ...localInput, gitDecorations: false }),
    ).toBeNull();
  });
});

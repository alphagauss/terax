/**
 * 本文件测试 Quick Diff HEAD 基线请求缓存。
 * 锁定并发合并、HEAD 变化后的旧请求隔离以及新 revision 缓存不变量。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  headListener: null as
    | ((repoRoot: string, revision: string | null) => void)
    | null,
}));

vi.mock("@/modules/ai/lib/native", () => ({
  native: { gitQuickDiffBaseline: mocks.load },
}));

vi.mock("@/modules/source-control/repositoryChanges", () => ({
  subscribeRepositoryHeadChanges: (
    listener: (repoRoot: string, revision: string | null) => void,
  ) => {
    mocks.headListener = listener;
    return () => undefined;
  },
}));

import { loadQuickDiffBaseline } from "./quickDiffBaseline";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("quick diff baseline cache", () => {
  beforeEach(() => mocks.load.mockReset());

  it("shares an in-flight request for the same workspace path", async () => {
    const result = {
      repoRoot: "/repo",
      relativePath: "shared.ts",
      revision: "one",
      content: "one\n",
    };
    mocks.load.mockResolvedValue(result);

    const first = loadQuickDiffBaseline("scope", "/repo/shared.ts");
    const second = loadQuickDiffBaseline("scope", "/repo/shared.ts");

    expect(first).toBe(second);
    await expect(first).resolves.toEqual(result);
    expect(mocks.load).toHaveBeenCalledOnce();
  });

  it("does not reuse or cache a request invalidated by a HEAD change", async () => {
    const oldRequest = deferred<{
      repoRoot: string;
      relativePath: string;
      revision: string;
      content: string;
    }>();
    const current = {
      repoRoot: "/repo",
      relativePath: "stale.ts",
      revision: "new",
      content: "new\n",
    };
    mocks.load
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce(current);

    const stale = loadQuickDiffBaseline("scope", "/repo/stale.ts");
    mocks.headListener?.("/repo", "new");
    const fresh = loadQuickDiffBaseline("scope", "/repo/stale.ts");
    oldRequest.resolve({ ...current, revision: "old", content: "old\n" });

    await stale;
    await expect(fresh).resolves.toEqual(current);
    await expect(
      loadQuickDiffBaseline("scope", "/repo/stale.ts"),
    ).resolves.toEqual(current);
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });

  it("keeps another repository cache when HEAD changes", async () => {
    const result = {
      repoRoot: "/repo/other",
      relativePath: "stable.ts",
      revision: "stable",
      content: "stable\n",
    };
    mocks.load.mockResolvedValue(result);

    await loadQuickDiffBaseline("other", "/repo/other/stable.ts");
    mocks.headListener?.("/repo/changed", "next");
    await loadQuickDiffBaseline("other", "/repo/other/stable.ts");

    expect(mocks.load).toHaveBeenCalledOnce();
  });

  it("keeps a current repository cache when the revision is unchanged", async () => {
    const result = {
      repoRoot: "/repo/current",
      relativePath: "current.ts",
      revision: "same",
      content: "same\n",
    };
    mocks.load.mockResolvedValue(result);

    await loadQuickDiffBaseline("current", "/repo/current/current.ts");
    mocks.headListener?.("/repo/current", "same");
    await loadQuickDiffBaseline("current", "/repo/current/current.ts");

    expect(mocks.load).toHaveBeenCalledOnce();
  });
});

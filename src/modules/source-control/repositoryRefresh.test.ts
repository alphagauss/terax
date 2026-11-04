/**
 * 本文件测试仓库刷新串行队列。
 * 锁定进行中请求之后必有一次补充刷新，且并发失效只合并为一轮尾随读取。
 */

import { describe, expect, it, vi } from "vitest";
import { createRepositoryRefreshQueue } from "./repositoryRefresh";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("repository refresh queue", () => {
  it("keeps invalidations arriving between the last read and queue cleanup", async () => {
    const run = vi.fn(async () => {});
    const queue = createRepositoryRefreshQueue(run);
    const first = queue.request();
    await Promise.resolve();
    const last = queue.request();
    await Promise.all([first, last]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("joins passive checks without dropping a real invalidation during a read", async () => {
    const firstRun = deferred();
    const run = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(firstRun.promise)
      .mockResolvedValue(undefined);
    const queue = createRepositoryRefreshQueue(run);
    const first = queue.request("check");
    expect(queue.request("check")).toBe(first);
    firstRun.resolve();
    await first;
    expect(run).toHaveBeenCalledTimes(1);
    const nextRun = deferred();
    run.mockReturnValueOnce(nextRun.promise);
    const next = queue.request("check");
    queue.request();
    queue.request("check");
    nextRun.resolve();
    await next;
    expect(run).toHaveBeenCalledTimes(3);
  });
  it("bounds pending invalidations and leaves a gap between slow rounds", async () => {
    vi.useFakeTimers();
    try {
      const firstRun = deferred();
      const run = vi
        .fn<() => Promise<void>>()
        .mockReturnValueOnce(firstRun.promise)
        .mockResolvedValue(undefined);
      const queue = createRepositoryRefreshQueue(run, () => 4000);
      const first = queue.request();
      for (let i = 0; i < 100; i++) expect(queue.request()).toBe(first);
      firstRun.resolve();
      await vi.advanceTimersByTimeAsync(3999);
      expect(run).toHaveBeenCalledOnce();
      for (let i = 0; i < 100; i++) queue.request();
      await vi.advanceTimersByTimeAsync(1);
      await first;
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

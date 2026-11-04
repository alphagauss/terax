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
  it("操作等待下一轮快照但不等待统计，且优先补查仍保持串行", async () => {
    const firstStats = deferred();
    const secondStats = deferred();
    const ready: Array<() => void> = [];
    const run = vi.fn((snapshotReady: () => void) => {
      ready.push(snapshotReady);
      return ready.length === 1 ? firstStats.promise : secondStats.promise;
    });
    const queue = createRepositoryRefreshQueue(run, () => 60_000);
    const fullRound = queue.request();
    const mutation = queue.request("mutation");
    let completed = false;
    void mutation.then(() => {
      completed = true;
    });
    ready[0]();
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(run).toHaveBeenCalledOnce();
    firstStats.resolve();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
    ready[1]();
    await mutation;
    expect(completed).toBe(true);
    let allFinished = false;
    void fullRound.then(() => {
      allFinished = true;
    });
    await Promise.resolve();
    expect(allFinished).toBe(false);
    secondStats.resolve();
    await fullRound;
  });

  it("操作补查释放已经开始的自动退避，取消时释放快照等待者", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async (ready: () => void) => {
        ready();
      });
      const queue = createRepositoryRefreshQueue(run, () => 60_000);
      const fullRound = queue.request();
      queue.request();
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledOnce();
      await queue.request("mutation");
      expect(run).toHaveBeenCalledTimes(2);
      await fullRound;
      const held = deferred();
      run.mockImplementationOnce(() => held.promise);
      const current = queue.request();
      const nextSnapshot = queue.request("mutation");
      queue.cancelPending();
      await nextSnapshot;
      held.resolve();
      await current;
      expect(run).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("隐藏后丢弃待执行的补查，并释放轮间等待", async () => {
    vi.useFakeTimers();
    try {
      const firstRun = deferred();
      const run = vi
        .fn()
        .mockReturnValueOnce(firstRun.promise)
        .mockResolvedValue(undefined);
      const queue = createRepositoryRefreshQueue(run, () => 4000);
      const task = queue.request();
      queue.request();
      firstRun.resolve();
      await vi.advanceTimersByTimeAsync(1);
      queue.cancelPending();
      await task;
      await vi.advanceTimersByTimeAsync(5000);
      expect(run).toHaveBeenCalledTimes(1);
      await queue.request();
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

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

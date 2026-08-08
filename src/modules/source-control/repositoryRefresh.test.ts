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
  it("runs one trailing refresh for requests received while inflight", async () => {
    const firstRun = deferred();
    const run = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(firstRun.promise)
      .mockResolvedValue(undefined);
    const queue = createRepositoryRefreshQueue(run);

    const first = queue.request();
    const second = queue.request();
    firstRun.resolve();
    await first;

    expect(second).toBe(first);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

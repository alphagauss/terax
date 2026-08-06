/**
 * 本文件测试仓库刷新串行队列。
 * 锁定进行中请求之后必有一次补充刷新，以及远程模式升级不会丢失的不变量。
 */

import { describe, expect, it, vi } from "vitest";
import {
  createRepositoryRefreshQueue,
  type RepositoryRefreshMode,
} from "./repositoryRefresh";

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
      .fn<(mode: RepositoryRefreshMode) => Promise<void>>()
      .mockReturnValueOnce(firstRun.promise)
      .mockResolvedValue(undefined);
    const queue = createRepositoryRefreshQueue(run);

    const first = queue.request("never");
    const second = queue.request("never");
    firstRun.resolve();
    await first;

    expect(second).toBe(first);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(1, "never");
    expect(run).toHaveBeenNthCalledWith(2, "never");
  });

  it("merges queued remote refreshes to the strongest mode", async () => {
    const firstRun = deferred();
    const modes: RepositoryRefreshMode[] = [];
    const queue = createRepositoryRefreshQueue(async (mode) => {
      modes.push(mode);
      if (modes.length === 1) await firstRun.promise;
    });

    const result = queue.request("never");
    queue.request("auto");
    queue.request("always");
    firstRun.resolve();
    await result;

    expect(modes).toEqual(["never", "always"]);
  });
});

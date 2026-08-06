/**
 * 本文件测试仓库 generation 通知。
 * 锁定仓库隔离、取消订阅以及 HEAD 信号不伪造状态 generation 的不变量。
 */

import { describe, expect, it, vi } from "vitest";
import {
  notifyRepositoryChanged,
  notifyRepositoryHeadChanged,
  repositoryGeneration,
  subscribeRepositoryChanges,
  subscribeRepositoryHeadChanges,
} from "./repositoryChanges";

describe("repository changes", () => {
  it("isolates generations and listeners by repository", () => {
    const first = "/repo/first";
    const second = "/repo/second";
    const listener = vi.fn();
    const unsubscribe = subscribeRepositoryChanges(first, listener);

    notifyRepositoryChanged(second);
    notifyRepositoryChanged(first);
    unsubscribe();
    notifyRepositoryChanged(first);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(repositoryGeneration(first)).toBe(2);
    expect(repositoryGeneration(second)).toBe(1);
  });

  it("keeps HEAD invalidation separate from repository generation", () => {
    const repo = "/repo/head";
    const listener = vi.fn();
    const unsubscribe = subscribeRepositoryHeadChanges(listener);

    notifyRepositoryHeadChanged(repo, "next");
    unsubscribe();
    notifyRepositoryHeadChanged(repo, "later");

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(repo, "next");
    expect(repositoryGeneration(repo)).toBe(0);
  });
});

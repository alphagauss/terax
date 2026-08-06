/**
 * 本文件提供仓库变化的轻量 generation 信号。
 * 信号只用于让派生视图重新读取数据，不保存仓库状态或 diff 内容。
 */

import { useSyncExternalStore } from "react";

const generations = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
const headListeners = new Set<
  (repoRoot: string, revision: string | null) => void
>();

/** 通知订阅者某仓库的真实状态快照已经变化。 */
export function notifyRepositoryChanged(repoRoot: string): void {
  generations.set(repoRoot, (generations.get(repoRoot) ?? 0) + 1);
  for (const listener of listeners.get(repoRoot) ?? []) listener();
}

/** 通知 HEAD 已变化，供只依赖提交基线的消费者精确失效。 */
export function notifyRepositoryHeadChanged(
  repoRoot: string,
  revision: string | null,
): void {
  for (const listener of headListeners) listener(repoRoot, revision);
}

/** 订阅 HEAD 变化，不创建第二份仓库状态。 */
export function subscribeRepositoryHeadChanges(
  listener: (repoRoot: string, revision: string | null) => void,
): () => void {
  headListeners.add(listener);
  return () => headListeners.delete(listener);
}

/** 订阅指定仓库的状态变化。 */
export function subscribeRepositoryChanges(
  repoRoot: string,
  listener: () => void,
): () => void {
  let repoListeners = listeners.get(repoRoot);
  if (!repoListeners) {
    repoListeners = new Set();
    listeners.set(repoRoot, repoListeners);
  }
  repoListeners.add(listener);
  return () => {
    repoListeners.delete(listener);
    if (repoListeners.size === 0) listeners.delete(repoRoot);
  };
}

/** 返回指定仓库当前的 generation。 */
export function repositoryGeneration(repoRoot: string): number {
  return generations.get(repoRoot) ?? 0;
}

/** 订阅仓库 generation，用于在已打开的派生视图中触发重新读取。 */
export function useRepositoryGeneration(repoRoot: string): number {
  return useSyncExternalStore(
    (listener) => subscribeRepositoryChanges(repoRoot, listener),
    () => repositoryGeneration(repoRoot),
    () => 0,
  );
}

/**
 * 本文件管理编辑器 Quick Diff 的只读 HEAD 基线请求。
 * 使用小型 LRU 和共享进行中请求，避免同一路径的分屏编辑器重复访问 Git。
 */

import { type GitQuickDiffBaseline, native } from "@/modules/ai/lib/native";
import { subscribeRepositoryHeadChanges } from "@/modules/source-control/repositoryChanges";
import { useCallback, useSyncExternalStore } from "react";

const MAX_ENTRIES = 32;
const cache = new Map<string, GitQuickDiffBaseline | null>();
const pending = new Map<string, Promise<GitQuickDiffBaseline | null>>();
const repoByKey = new Map<string, string>();
const generations = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
const knownHeadRevisions = new Map<string, string | null>();
let invalidationVersion = 0;

function baselineKey(scope: string, path: string): string {
  return `${scope}\0${path}`;
}

function notifyKey(key: string): void {
  generations.set(key, (generations.get(key) ?? 0) + 1);
  for (const listener of listeners.get(key) ?? []) listener();
}

function cleanupKeyMetadata(key: string): void {
  if (cache.has(key) || pending.has(key) || listeners.has(key)) return;
  repoByKey.delete(key);
  generations.delete(key);
}

/** 读取路径的 HEAD 文本基线，并合并同一路径的并发请求。 */
export function loadQuickDiffBaseline(
  scope: string,
  path: string,
): Promise<GitQuickDiffBaseline | null> {
  const key = baselineKey(scope, path);
  const cached = cache.get(key);
  if (cached !== undefined || cache.has(key)) {
    cache.delete(key);
    cache.set(key, cached ?? null);
    return Promise.resolve(cached ?? null);
  }
  const active = pending.get(key);
  if (active) return active;

  const requestVersion = invalidationVersion;
  const request = native.gitQuickDiffBaseline(path).then((baseline) => {
    const knownRevision = baseline
      ? knownHeadRevisions.get(baseline.repoRoot)
      : undefined;
    const canCache = baseline
      ? knownRevision === undefined || knownRevision === baseline.revision
      : invalidationVersion === requestVersion;
    if (canCache) {
      cache.set(key, baseline);
      if (baseline) repoByKey.set(key, baseline.repoRoot);
      while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value as string;
        cache.delete(oldest);
        cleanupKeyMetadata(oldest);
      }
    }
    return baseline;
  });
  const tracked = request.finally(() => {
    if (pending.get(key) === tracked) {
      pending.delete(key);
      cleanupKeyMetadata(key);
    }
  });
  pending.set(key, tracked);
  return tracked;
}

/** 清除仓库 HEAD 变化后失效的基线。 */
function invalidateQuickDiffBaselines(
  repoRoot: string,
  revision: string | null,
): void {
  invalidationVersion++;
  knownHeadRevisions.set(repoRoot, revision);
  const affected = new Set<string>();
  for (const [key, baseline] of cache) {
    if (
      !baseline ||
      (baseline.repoRoot === repoRoot && baseline.revision !== revision)
    ) {
      cache.delete(key);
      affected.add(key);
    }
  }
  for (const key of listeners.keys()) {
    const knownRepo = repoByKey.get(key);
    if (!knownRepo || (knownRepo === repoRoot && !cache.has(key))) {
      affected.add(key);
    }
  }
  for (const key of pending.keys()) {
    const knownRepo = repoByKey.get(key);
    if (!knownRepo || knownRepo === repoRoot) {
      pending.delete(key);
      affected.add(key);
    }
  }
  for (const key of affected) {
    notifyKey(key);
    cleanupKeyMetadata(key);
  }
}

subscribeRepositoryHeadChanges(invalidateQuickDiffBaselines);

/** 订阅当前文件的 HEAD 基线失效信号。 */
export function useQuickDiffBaselineGeneration(
  scope: string,
  path: string,
): number {
  const key = baselineKey(scope, path);
  const subscribe = useCallback(
    (listener: () => void) => {
      let keyListeners = listeners.get(key);
      if (!keyListeners) {
        keyListeners = new Set();
        listeners.set(key, keyListeners);
      }
      keyListeners.add(listener);
      return () => {
        keyListeners.delete(listener);
        if (keyListeners.size === 0) {
          listeners.delete(key);
          cleanupKeyMetadata(key);
        }
      };
    },
    [key],
  );
  const getSnapshot = useCallback(() => generations.get(key) ?? 0, [key]);
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}

/**
 * 本文件管理当前进程中的 Alpha 工作台共享状态和持久化调度。
 * 所有窗口读取并写入同一个白名单 store，状态更新统一合并到 `workstation` 键。
 */

import {
  onSharedStoreChange,
  readSharedStore,
  setSharedStoreKey,
} from "@/lib/sharedStore";
import type { AlphaWorkstationState } from "@/modules/alpha/workstation/model";
import { alphaPanelRegistry } from "@/modules/alpha/workstation/panelRegistry";
import { parseAlphaWorkstationState } from "@/modules/alpha/workstation/state";
import { createDefaultAlphaWorkstationState } from "@/modules/alpha/workstation/templates";
import { useEffect, useSyncExternalStore } from "react";

const WORKSTATION_KEY = "workstation";
const WRITE_DELAY_MS = 200;

export type AlphaWorkstationSnapshot = {
  hydrated: boolean;
  state: AlphaWorkstationState | null;
};

let snapshot: AlphaWorkstationSnapshot = { hydrated: false, state: null };
let defaultState: AlphaWorkstationState | null = null;
let subscriptionPromise: Promise<void> | null = null;
let unsubscribeSharedStore: (() => void) | null = null;
let pendingWrite: AlphaWorkstationState | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let writeInFlight: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function fallbackState(): AlphaWorkstationState {
  defaultState ??= createDefaultAlphaWorkstationState();
  return defaultState;
}

function fingerprint(state: AlphaWorkstationState): string {
  return JSON.stringify(state);
}

function publish(state: AlphaWorkstationState): void {
  if (snapshot.state && fingerprint(snapshot.state) === fingerprint(state)) {
    if (snapshot.hydrated) return;
  }
  snapshot = { hydrated: true, state };
  for (const listener of listeners) listener();
}

async function refreshFromSharedStore(): Promise<void> {
  const values = await readSharedStore("alpha");
  publish(
    parseAlphaWorkstationState(values[WORKSTATION_KEY], alphaPanelRegistry) ??
      fallbackState(),
  );
}

/** 按需启动 Alpha 工作台共享配置读取和跨窗口监听。 */
export function initializeAlphaWorkstationStore(): Promise<void> {
  if (subscriptionPromise) return subscriptionPromise;
  subscriptionPromise = (async () => {
    await refreshFromSharedStore();
    unsubscribeSharedStore = await onSharedStoreChange(
      "alpha",
      refreshFromSharedStore,
    );
  })().catch((error) => {
    subscriptionPromise = null;
    console.error(
      "[alpha-workstation] shared state initialization failed",
      error,
    );
    if (!snapshot.hydrated) publish(fallbackState());
  });
  return subscriptionPromise;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AlphaWorkstationSnapshot {
  return snapshot;
}

/** 订阅当前进程共享的工作台状态，首次使用时才访问持久化文件。 */
export function useAlphaWorkstationSnapshot(): AlphaWorkstationSnapshot {
  useEffect(() => {
    void initializeAlphaWorkstationStore();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function scheduleWrite(state: AlphaWorkstationState): void {
  pendingWrite = state;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void flushAlphaWorkstationWrites().catch((error) => {
      console.error(
        "[alpha-workstation] shared state persistence failed",
        error,
      );
    });
  }, WRITE_DELAY_MS);
}

/**
 * 更新当前进程的工作台状态并调度共享配置写入。
 */
export function updateAlphaWorkstationState(
  update: (current: AlphaWorkstationState) => AlphaWorkstationState,
): void {
  const current = snapshot.state ?? fallbackState();
  const next = update(current);
  if (next === current || fingerprint(next) === fingerprint(current)) return;
  const validated = parseAlphaWorkstationState(next, alphaPanelRegistry);
  if (!validated) return;
  publish(validated);
  scheduleWrite(validated);
}

/** 立即提交所有已合并的 Alpha 工作台写入，供应用关闭流程调用。 */
export async function flushAlphaWorkstationWrites(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  writeInFlight = writeInFlight
    .catch(() => undefined)
    .then(async () => {
      while (pendingWrite) {
        const state = pendingWrite;
        pendingWrite = null;
        try {
          await setSharedStoreKey("alpha", WORKSTATION_KEY, state);
        } catch (error) {
          pendingWrite ??= state;
          throw error;
        }
      }
    });
  await writeInFlight;
}

/** 清理模块级状态，供隔离测试复用同一 JavaScript 进程。 */
export function resetAlphaWorkstationStoreForTests(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  pendingWrite = null;
  writeInFlight = Promise.resolve();
  unsubscribeSharedStore?.();
  unsubscribeSharedStore = null;
  subscriptionPromise = null;
  defaultState = null;
  snapshot = { hydrated: false, state: null };
  listeners.clear();
}

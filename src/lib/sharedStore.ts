/**
 * 本文件封装跨 Terax 进程共享的白名单配置存储。
 * 单键和批量精确变更均由 Rust 端加锁并原子替换，禁止前端整表覆盖。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SharedStoreName =
  | "channels"
  | "settings"
  | "alpha"
  | "ssh-profiles"
  | "custom-themes"
  | "ai-agents"
  | "ai-snippets"
  | "ui-layout"
  | "keys-epoch";

const pendingWrites = new Set<Promise<void>>();

/** 跟踪跨进程共享存储写入，供应用关闭前等待所有原子替换完成。 */
function trackSharedStoreWrite(operation: Promise<void>): Promise<void> {
  pendingWrites.add(operation);
  const remove = () => pendingWrites.delete(operation);
  void operation.then(remove, remove);
  return operation;
}

export function readSharedStore(
  store: SharedStoreName,
): Promise<Record<string, unknown>> {
  return invoke("shared_store_read", { store });
}

export function setSharedStoreKey(
  store: SharedStoreName,
  key: string,
  value: unknown,
): Promise<void> {
  return trackSharedStoreWrite(
    invoke("shared_store_set", { store, key, value }),
  );
}

export function deleteSharedStoreKey(
  store: SharedStoreName,
  key: string,
): Promise<void> {
  return trackSharedStoreWrite(invoke("shared_store_delete", { store, key }));
}

export type SharedStoreMutation =
  | { kind: "set"; key: string; value: unknown }
  | { kind: "delete"; key: string };

/** 在同一把文件锁内原子应用一组精确的共享存储键变更。 */
export function mutateSharedStore(
  store: SharedStoreName,
  mutations: SharedStoreMutation[],
): Promise<void> {
  return trackSharedStoreWrite(
    invoke("shared_store_mutate", { store, mutations }),
  );
}

/** 等待当前所有共享存储写入完成。 */
export async function flushSharedStoreWrites(): Promise<void> {
  while (pendingWrites.size > 0) {
    await Promise.all(pendingWrites);
  }
}

function sharedStoreRevision(store: SharedStoreName): Promise<string> {
  return invoke("shared_store_revision", { store });
}

const REVISION_DEBOUNCE_MS = 100;

export async function onSharedStoreChange(
  store: SharedStoreName,
  callback: () => void | Promise<void>,
): Promise<UnlistenFn> {
  let lastRevision: string | null = null;
  let timer: number | null = null;
  let checking = false;
  let pending = false;
  let disposed = false;

  const check = async (force = false) => {
    if (disposed) return;
    if (checking) {
      pending = true;
      return;
    }
    checking = true;
    try {
      const next = await sharedStoreRevision(store).catch(() => lastRevision);
      if (next === null) return;
      if (!force && next === lastRevision) return;
      await callback();
      lastRevision = next;
    } finally {
      checking = false;
      if (pending && !disposed) {
        pending = false;
        void check().catch((error) => {
          console.error(`[terax] ${store} shared-store refresh failed:`, error);
        });
      }
    }
  };

  const schedule = () => {
    if (disposed) return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      void check().catch((error) => {
        console.error(`[terax] ${store} shared-store refresh failed:`, error);
      });
    }, REVISION_DEBOUNCE_MS);
  };

  const unlisten = await listen<{ store: string }>(
    "terax://shared-store-changed",
    (event) => {
      if (event.payload.store === store) schedule();
    },
  );
  window.addEventListener("focus", schedule);

  const dispose = () => {
    disposed = true;
    if (timer !== null) window.clearTimeout(timer);
    unlisten();
    window.removeEventListener("focus", schedule);
  };

  // The listener is active before the baseline read. Force one reload so a
  // write between a caller's initial read and this subscription cannot vanish.
  await check(true).catch((error) => {
    console.error(`[terax] ${store} shared-store refresh failed:`, error);
  });

  return dispose;
}

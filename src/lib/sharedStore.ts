import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SharedStoreName =
  | "settings"
  | "ssh-profiles"
  | "custom-themes"
  | "ai-agents"
  | "ai-snippets"
  | "keys-epoch";

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
  return invoke("shared_store_set", { store, key, value });
}

export function deleteSharedStoreKey(
  store: SharedStoreName,
  key: string,
): Promise<void> {
  return invoke("shared_store_delete", { store, key });
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

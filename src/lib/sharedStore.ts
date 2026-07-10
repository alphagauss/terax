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

export function sharedStoreRevision(store: SharedStoreName): Promise<string> {
  return invoke("shared_store_revision", { store });
}

export async function onSharedStoreChange(
  store: SharedStoreName,
  callback: () => void,
): Promise<UnlistenFn> {
  let lastRevision = await sharedStoreRevision(store).catch(() => "");
  const check = async () => {
    const next = await sharedStoreRevision(store).catch(() => lastRevision);
    if (next === lastRevision) return;
    lastRevision = next;
    callback();
  };
  const unlisten = await listen<{ store: string; revision: string }>(
    "terax://shared-store-changed",
    (event) => {
      if (event.payload.store !== store) return;
      lastRevision = event.payload.revision;
      callback();
    },
  );
  window.addEventListener("focus", check);
  return () => {
    unlisten();
    window.removeEventListener("focus", check);
  };
}

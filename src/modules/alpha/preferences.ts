/**
 * 本文件管理 Alpha 在非本地 Workspace 中的可见性设置。
 * 设置跨 Terax 进程共享，缺失或无效值始终回退为仅 Local 环境显示。
 */

import {
  onSharedStoreChange,
  readSharedStore,
  setSharedStoreKey,
} from "@/lib/sharedStore";
import { useEffect, useState } from "react";

const REMOTE_VISIBILITY_KEY = "alphaShowInRemoteEnvironments";

let cachedShowInRemoteEnvironments = false;
const listeners = new Set<(value: boolean) => void>();

/** 从共享设置中读取 Alpha 远端环境可见性，默认关闭。 */
export function alphaShowInRemoteFromValues(
  values: Record<string, unknown>,
): boolean {
  return values[REMOTE_VISIBILITY_KEY] === true;
}

async function refreshCachedPreference(): Promise<void> {
  const values = await readSharedStore("settings");
  cachedShowInRemoteEnvironments = alphaShowInRemoteFromValues(values);
  for (const listener of listeners) {
    listener(cachedShowInRemoteEnvironments);
  }
}

/** 在主应用首帧前加载 Alpha 可见性，避免远端环境短暂显示入口。 */
export async function initializeAlphaPreferences(): Promise<void> {
  try {
    await refreshCachedPreference();
  } catch (error) {
    console.error("[terax] Alpha visibility initialization failed:", error);
  }
}

/** 返回启动阶段已加载的 Alpha 远端环境可见性。 */
export function getInitialAlphaShowInRemote(): boolean {
  return cachedShowInRemoteEnvironments;
}

/** 保存 Alpha 是否在 WSL 和 SSH 等非本地环境显示。 */
export async function setAlphaShowInRemote(enabled: boolean): Promise<void> {
  await setSharedStoreKey("settings", REMOTE_VISIBILITY_KEY, enabled);
  cachedShowInRemoteEnvironments = enabled;
  for (const listener of listeners) listener(enabled);
}

/** 订阅跨进程共享的 Alpha 远端环境可见性。 */
export function useAlphaShowInRemote(): boolean {
  const [enabled, setEnabled] = useState(cachedShowInRemoteEnvironments);

  useEffect(() => {
    listeners.add(setEnabled);
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void onSharedStoreChange("settings", refreshCachedPreference).then(
      (unlisten) => {
        if (cancelled) unlisten();
        else dispose = unlisten;
      },
    );
    return () => {
      cancelled = true;
      listeners.delete(setEnabled);
      dispose?.();
    };
  }, []);

  return enabled;
}

/**
 * 本文件管理侧边栏容器位置和顺序的跨进程共享存储。
 * 仅接受当前版本的新结构，不读取或迁移旧侧边栏设置键。
 */

import {
  onSharedStoreChange,
  readSharedStore,
  setSharedStoreKey,
} from "@/lib/sharedStore";
import {
  DEFAULT_SIDEBAR_PLACEMENT_STATE,
  normalizeSidebarPlacementState,
} from "./model";
import type { SidebarPlacementState } from "./types";

const STORE_KEY = "sidebar";

let cachedPlacementState = DEFAULT_SIDEBAR_PLACEMENT_STATE;

async function readPlacementState(): Promise<SidebarPlacementState> {
  const values = await readSharedStore("ui-layout");
  return normalizeSidebarPlacementState(values[STORE_KEY]);
}

/** 在应用首次渲染前加载共享侧边栏布局，避免容器位置在首帧后跳变。 */
export async function initializeSidebarLayout(): Promise<void> {
  try {
    cachedPlacementState = await readPlacementState();
  } catch (error) {
    console.error("[terax] sidebar layout initialization failed:", error);
  }
}

/** 同步返回启动阶段已经加载并归一化的侧边栏布局。 */
export function getInitialSidebarPlacementState(): SidebarPlacementState {
  return cachedPlacementState;
}

/** 原子写入当前侧边栏位置和顺序。 */
export async function persistSidebarPlacementState(
  state: SidebarPlacementState,
): Promise<void> {
  cachedPlacementState = state;
  await setSharedStoreKey("ui-layout", STORE_KEY, state);
}

/** 订阅其他 Terax 进程提交的侧边栏布局变化。 */
export function subscribeSidebarPlacementState(
  callback: (state: SidebarPlacementState) => void,
): Promise<() => void> {
  return onSharedStoreChange("ui-layout", async () => {
    cachedPlacementState = await readPlacementState();
    callback(cachedPlacementState);
  });
}

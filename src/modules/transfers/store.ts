/**
 * 本文件维护当前 Workspace 的文件传输前端快照。
 * Rust 是任务状态的唯一事实来源，Zustand 只合并列表快照、更新事件和移除事件。
 */

import { useEffect } from "react";
import { create } from "zustand";
import { transferNative } from "./native";
import type { TransferTask } from "./types";

type TransferStore = {
  tasks: Record<string, TransferTask>;
  panelOpen: boolean;
  mergeList: (tasks: TransferTask[]) => void;
  upsert: (task: TransferTask) => void;
  removeLocal: (id: string) => void;
  removeLocalMany: (ids: readonly string[]) => void;
  setPanelOpen: (open: boolean) => void;
};

/** 合并后端列表，同时保留监听期间收到的更新版本。 */
export function mergeTransferTasks(
  current: Record<string, TransferTask>,
  incoming: TransferTask[],
  removed?: ReadonlySet<string>,
): Record<string, TransferTask> {
  const next = { ...current };
  for (const task of incoming) {
    if (removed?.has(task.id)) continue;
    const known = next[task.id];
    if (!known || task.updatedAt >= known.updatedAt) next[task.id] = task;
  }
  return next;
}

/** 当前 Workspace 进程内的传输任务视图。 */
export const useTransferStore = create<TransferStore>((set) => ({
  tasks: {},
  panelOpen: false,
  mergeList: (tasks) =>
    set((state) => ({ tasks: mergeTransferTasks(state.tasks, tasks) })),
  upsert: (task) =>
    set((state) => {
      const known = state.tasks[task.id];
      if (known && known.updatedAt > task.updatedAt) return state;
      return { tasks: { ...state.tasks, [task.id]: task } };
    }),
  removeLocal: (id) =>
    set((state) => {
      if (!state.tasks[id]) return state;
      const tasks = { ...state.tasks };
      delete tasks[id];
      return { tasks };
    }),
  removeLocalMany: (ids) =>
    set((state) => {
      const tasks = { ...state.tasks };
      let changed = false;
      for (const id of ids) {
        if (!tasks[id]) continue;
        delete tasks[id];
        changed = true;
      }
      return changed ? { tasks } : state;
    }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
}));

/** 请求打开状态栏传输面板，供资源管理器等非状态栏模块调用。 */
export function openTransferPanel(): void {
  useTransferStore.getState().setPanelOpen(true);
}

/** 在状态栏挂载期间订阅传输事件，并在订阅建立后读取完整快照。 */
export function useTransferBridge(): void {
  useEffect(() => {
    let active = true;
    let initialized = false;
    const removedDuringInitialization = new Set<string>();
    let unlistenUpdated: (() => void) | undefined;
    let unlistenRemoved: (() => void) | undefined;
    void (async () => {
      try {
        unlistenUpdated = await transferNative.onUpdated((task) => {
          if (active) useTransferStore.getState().upsert(task);
        });
        if (!active) {
          unlistenUpdated();
          unlistenUpdated = undefined;
          return;
        }
        unlistenRemoved = await transferNative.onRemoved((id) => {
          if (!initialized) removedDuringInitialization.add(id);
          if (active) useTransferStore.getState().removeLocal(id);
        });
        if (!active) {
          unlistenUpdated();
          unlistenRemoved();
          unlistenUpdated = undefined;
          unlistenRemoved = undefined;
          return;
        }
        const tasks = await transferNative.list();
        if (active) {
          useTransferStore.setState((state) => ({
            tasks: mergeTransferTasks(
              state.tasks,
              tasks,
              removedDuringInitialization,
            ),
          }));
          initialized = true;
        }
      } catch (error) {
        unlistenUpdated?.();
        unlistenRemoved?.();
        unlistenUpdated = undefined;
        unlistenRemoved = undefined;
        console.error("[transfers] failed to initialize task bridge", error);
      }
    })();
    return () => {
      active = false;
      unlistenUpdated?.();
      unlistenRemoved?.();
    };
  }, []);
}

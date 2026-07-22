/**
 * 本文件维护当前 Workspace 的文件传输前端快照。
 * Rust 是任务状态的唯一事实来源，Zustand 只合并列表快照和增量事件。
 */

import { useEffect } from "react";
import { create } from "zustand";
import { transferNative } from "./native";
import type { TransferTask } from "./types";

type TransferStore = {
  tasks: Record<string, TransferTask>;
  mergeList: (tasks: TransferTask[]) => void;
  upsert: (task: TransferTask) => void;
  removeLocal: (id: string) => void;
};

/** 合并后端列表，同时保留监听期间收到的更新版本。 */
export function mergeTransferTasks(
  current: Record<string, TransferTask>,
  incoming: TransferTask[],
): Record<string, TransferTask> {
  const next = { ...current };
  for (const task of incoming) {
    const known = next[task.id];
    if (!known || task.updatedAt >= known.updatedAt) next[task.id] = task;
  }
  return next;
}

/** 当前 Workspace 进程内的传输任务视图。 */
export const useTransferStore = create<TransferStore>((set) => ({
  tasks: {},
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
}));

/** 在状态栏挂载期间订阅传输事件，并在订阅建立后读取完整快照。 */
export function useTransferBridge(): void {
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const stop = await transferNative.onUpdated((task) => {
          if (active) useTransferStore.getState().upsert(task);
        });
        if (!active) {
          stop();
          return;
        }
        unlisten = stop;
        const tasks = await transferNative.list();
        if (active) useTransferStore.getState().mergeList(tasks);
      } catch (error) {
        console.error("[transfers] failed to initialize task bridge", error);
      }
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
}

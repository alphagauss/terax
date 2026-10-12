/**
 * 本文件维护当前 Workspace 的文件传输前端快照。
 * Rust 是任务状态的唯一事实来源，Zustand 合并任务事件并在预检结束后展示传输面板。
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { reportError } from "@/lib/errors";
import { create } from "zustand";
import { transferNative } from "./native";
import type { TransferTask } from "./types";

type TransferStore = {
  tasks: Record<string, TransferTask>;
  panelOpen: boolean;
  pendingPanelTaskIds: Record<string, true>;
  mergeList: (tasks: TransferTask[]) => void;
  upsert: (task: TransferTask) => void;
  removeLocal: (id: string) => void;
  removeLocalMany: (ids: readonly string[]) => void;
  setPanelOpen: (open: boolean) => void;
  requestPanelForTask: (id: string) => void;
};

type PanelRequestResult = {
  pendingPanelTaskIds: Record<string, true>;
  openPanel: boolean;
};

/** 在任务结束预检或提前失败后消费面板展示请求。 */
function resolvePanelRequests(
  tasks: Record<string, TransferTask>,
  pendingPanelTaskIds: Record<string, true>,
): PanelRequestResult {
  let nextPending = pendingPanelTaskIds;
  let openPanel = false;
  for (const id of Object.keys(pendingPanelTaskIds)) {
    const task = tasks[id];
    if (!task) continue;
    const canceled = task.status === "canceling" || task.status === "canceled";
    const preflight =
      task.stage === "queued" ||
      task.stage === "scanning" ||
      task.stage === "checking_conflicts";
    if (!canceled && preflight) continue;
    if (nextPending === pendingPanelTaskIds) {
      nextPending = { ...pendingPanelTaskIds };
    }
    delete nextPending[id];
    if (!canceled) openPanel = true;
  }
  return { pendingPanelTaskIds: nextPending, openPanel };
}

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
  pendingPanelTaskIds: {},
  mergeList: (tasks) =>
    set((state) => {
      const nextTasks = mergeTransferTasks(state.tasks, tasks);
      const request = resolvePanelRequests(
        nextTasks,
        state.pendingPanelTaskIds,
      );
      return {
        tasks: nextTasks,
        pendingPanelTaskIds: request.pendingPanelTaskIds,
        panelOpen: request.openPanel || state.panelOpen,
      };
    }),
  upsert: (task) =>
    set((state) => {
      const known = state.tasks[task.id];
      if (known && known.updatedAt > task.updatedAt) return state;
      const tasks = { ...state.tasks, [task.id]: task };
      const request = resolvePanelRequests(tasks, state.pendingPanelTaskIds);
      return {
        tasks,
        pendingPanelTaskIds: request.pendingPanelTaskIds,
        panelOpen: request.openPanel || state.panelOpen,
      };
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
  requestPanelForTask: (id) =>
    set((state) => {
      const pendingPanelTaskIds = {
        ...state.pendingPanelTaskIds,
        [id]: true as const,
      };
      const request = resolvePanelRequests(state.tasks, pendingPanelTaskIds);
      return {
        pendingPanelTaskIds: request.pendingPanelTaskIds,
        panelOpen: request.openPanel || state.panelOpen,
      };
    }),
}));

/** 登记任务在完成预检后自动展示，登记时同步检查已到达的最新快照。 */
export function requestTransferPanel(id: string): void {
  useTransferStore.getState().requestPanelForTask(id);
}

/** 在状态栏挂载期间订阅传输事件，并在订阅建立后读取完整快照。 */
export function useTransferBridge(): void {
  const { t } = useTranslation("explorer");
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void transferNative
      .onSyncSaveFailed(() => {
        if (active) reportError(t("sync.saveFailed"));
      })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      })
      .catch((error) =>
        console.error(
          "[transfers] failed to listen for sync settings errors",
          error,
        ),
      );
    return () => {
      active = false;
      unlisten?.();
    };
  }, [t]);
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
          useTransferStore.setState((state) => {
            const nextTasks = mergeTransferTasks(
              state.tasks,
              tasks,
              removedDuringInitialization,
            );
            const request = resolvePanelRequests(
              nextTasks,
              state.pendingPanelTaskIds,
            );
            return {
              tasks: nextTasks,
              pendingPanelTaskIds: request.pendingPanelTaskIds,
              panelOpen: request.openPanel || state.panelOpen,
            };
          });
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

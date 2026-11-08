/**
 * 本文件负责工作台 Space 布局的延迟持久化。
 *
 * 常规状态变化经过防抖合并，应用主动关闭时可立即刷新并等待所有在途写入完成。
 */

import { serializeSpaceWorkbench } from "@/modules/spaces/lib/serialize";
import { saveState } from "@/modules/spaces/lib/store";
import type { WorkbenchState } from "@/modules/workbench";
import { useCallback, useEffect, useRef } from "react";

const DEBOUNCE_MS = 3000;
const EMPTY_STATE = "empty";

type Params = {
  state: WorkbenchState;
  enabled: boolean;
};

type PendingWrite = {
  fingerprint: string;
  operation: Promise<void>;
};

/**
 * 持久化所有 Space 的工作台布局，并提供绕过防抖的关闭前刷新函数。
 */
export function useSpacePersistence({ state, enabled }: Params) {
  const last = useRef(new Map<string, string>());
  const pending = useRef(new Map<string, PendingWrite>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(state);
  latest.current = state;

  const flush = useCallback(async (snapshot: WorkbenchState) => {
    const operations: Promise<void>[] = [];
    for (const spaceId of Object.keys(snapshot.spaces)) {
      const workbench = serializeSpaceWorkbench(snapshot, spaceId);
      const fingerprint = workbench ? JSON.stringify(workbench) : EMPTY_STATE;
      const pendingWrite = pending.current.get(spaceId);
      if (pendingWrite?.fingerprint === fingerprint) {
        operations.push(pendingWrite.operation);
        continue;
      }
      // 在途写入会覆盖已落盘布局，回到旧布局也必须排在它之后写入。
      if (!pendingWrite && last.current.get(spaceId) === fingerprint) continue;

      const tracked = saveState(spaceId, { version: 2, workbench })
        .then(() => {
          last.current.set(spaceId, fingerprint);
        })
        .catch((error) => {
          console.error(`[spaces] failed to persist ${spaceId}`, error);
          throw error;
        })
        .finally(() => {
          if (pending.current.get(spaceId)?.operation === tracked) {
            pending.current.delete(spaceId);
          }
        });
      pending.current.set(spaceId, { fingerprint, operation: tracked });
      operations.push(tracked);
    }
    await Promise.all(operations);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void flush(state).catch(() => undefined);
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, flush, state]);

  useEffect(() => {
    if (!enabled) return;
    const onHidden = () => {
      if (document.visibilityState === "hidden") {
        void flush(latest.current).catch(() => undefined);
      }
    };
    const onLeave = () => void flush(latest.current).catch(() => undefined);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("blur", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("blur", onLeave);
      window.removeEventListener("beforeunload", onLeave);
      void flush(latest.current).catch(() => undefined);
    };
  }, [enabled, flush]);

  return useCallback(async () => {
    if (!enabled) return;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    await flush(latest.current);
  }, [enabled, flush]);
}

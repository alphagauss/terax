/**
 * 本文件协调应用主动关闭前的文档保存、运行状态持久化和关闭确认。
 *
 * 保存耗时过长或失败时保留窗口，并允许用户取消等待或明确强制退出。
 */

import { countDirtyDocuments } from "@/modules/editor";
import { leafHasForegroundProcess } from "@/modules/terminal";
import type { Tab } from "@/modules/workbench";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

async function anyTerminalBusy(tabs: Tab[]): Promise<boolean> {
  const terminalIds = tabs.flatMap((tab) =>
    tab.kind === "terminal" ? [tab.terminalId] : [],
  );
  if (terminalIds.length === 0) return false;
  const checks = await Promise.all(terminalIds.map(leafHasForegroundProcess));
  return checks.some(Boolean);
}

export type AppCloseBlocker = {
  kind: "blocker";
  dirtyEditors: number;
  busyTerminal: boolean;
};

export type AppCloseSaving = {
  kind: "saving";
};

export type AppCloseFailure = {
  kind: "failed";
  reason: string;
};

export type AppCloseDialogState =
  | AppCloseBlocker
  | AppCloseSaving
  | AppCloseFailure;

const SLOW_CLOSE_MS = 3000;

function closeFailureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 拦截应用关闭，等待自动保存和状态落盘，并管理阻塞、超时与失败对话框。
 */
export function useAppCloseGuard(
  tabsRef: RefObject<Tab[]>,
  beforeClose?: () => Promise<void>,
  saveAutoSaveDocuments?: () => Promise<boolean>,
) {
  const [pendingAppClose, setPendingAppClose] =
    useState<AppCloseDialogState | null>(null);
  const forceClose = useRef(false);
  const closeAttempt = useRef(0);
  const closeInProgress = useRef(false);

  const forceAppClose = useCallback(() => {
    closeAttempt.current += 1;
    closeInProgress.current = false;
    forceClose.current = true;
    setPendingAppClose(null);
    void getCurrentWindow()
      .close()
      .catch((error) => {
        forceClose.current = false;
        setPendingAppClose({
          kind: "failed",
          reason: closeFailureReason(error),
        });
      });
  }, []);

  const beginAppClose = useCallback(
    (ignoreBlockers: boolean) => {
      if (closeInProgress.current) return;
      closeInProgress.current = true;
      setPendingAppClose(null);
      const attempt = ++closeAttempt.current;
      const slowTimer = setTimeout(() => {
        if (closeAttempt.current === attempt) {
          setPendingAppClose({ kind: "saving" });
        }
      }, SLOW_CLOSE_MS);

      void (async () => {
        try {
          const autoSavedDocuments =
            (await saveAutoSaveDocuments?.()) ?? false;
          const busyTerminal = ignoreBlockers
            ? false
            : await anyTerminalBusy(tabsRef.current);
          if (closeAttempt.current !== attempt) return;

          // 自动保存完成后再统计，避免已经落盘的文件继续阻止退出。
          const dirtyEditors = autoSavedDocuments
            ? 0
            : countDirtyDocuments(tabsRef.current);
          if (!ignoreBlockers && (dirtyEditors > 0 || busyTerminal)) {
            closeInProgress.current = false;
            setPendingAppClose({
              kind: "blocker",
              dirtyEditors,
              busyTerminal,
            });
            return;
          }

          await beforeClose?.();
          if (closeAttempt.current !== attempt) return;
          closeInProgress.current = false;
          forceClose.current = true;
          setPendingAppClose(null);
          await getCurrentWindow().close();
        } catch (error) {
          if (closeAttempt.current !== attempt) return;
          closeInProgress.current = false;
          forceClose.current = false;
          setPendingAppClose({
            kind: "failed",
            reason: closeFailureReason(error),
          });
        } finally {
          clearTimeout(slowTimer);
        }
      })();
    },
    [beforeClose, saveAutoSaveDocuments, tabsRef],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (forceClose.current) return;
        event.preventDefault();
        beginAppClose(false);
      })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [beginAppClose]);

  const confirmAppClose = useCallback(() => {
    if (pendingAppClose?.kind === "blocker") {
      beginAppClose(true);
      return;
    }
    forceAppClose();
  }, [beginAppClose, forceAppClose, pendingAppClose]);

  const cancelAppClose = useCallback(() => {
    closeAttempt.current += 1;
    closeInProgress.current = false;
    setPendingAppClose(null);
  }, []);

  return { pendingAppClose, confirmAppClose, cancelAppClose };
}

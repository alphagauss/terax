/**
 * 本文件管理标签关闭前的脏文档和终端任务确认流程。
 * 批量关闭固定目标标签，并在确认前保留整批标签。
 */

import { tabCloseDocuments } from "@/app/lib/tabCloseDocuments";
import { hasOtherDocumentView, isDocumentTab } from "@/modules/editor";
import { terminalNeedsCloseConfirmation } from "@/modules/terminal";
import type { Tab } from "@/modules/workbench";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { useCallback, useRef, useState } from "react";

type Params = {
  getTabs: () => Tab[];
  disposeTabs: (ids: readonly number[]) => void;
};

export type CloseAllTabsConfirmation = {
  tabIds: number[];
  spaces: number;
  dirtyDocuments: number;
  terminalsToConfirm: number;
};

/** 管理关闭确认状态，并在无需确认时释放目标标签。 */
export function useTabCloseGuards({ getTabs, disposeTabs }: Params) {
  const [pendingCloseTab, setPendingCloseTab] = useState<number | null>(null);
  const [pendingTerminalCloseTab, setPendingTerminalCloseTab] = useState<
    number | null
  >(null);
  const [pendingDeleteTabs, setPendingDeleteTabs] = useState<number[] | null>(
    null,
  );
  const [closeAll, setCloseAll] = useState<
    "checking" | CloseAllTabsConfirmation | null
  >(null);
  const closeAllInProgress = useRef(false);

  const handleClose = useCallback(
    async (id: number) => {
      const tabs = getTabs();
      const t = tabs.find((x) => x.id === id);
      if (!t) return;
      if (isDocumentTab(t) && t.dirty) {
        if (!hasOtherDocumentView(tabs, t)) {
          setPendingCloseTab(id);
          return;
        }
      }
      if (t.kind === "terminal") {
        if (await terminalNeedsCloseConfirmation(t.id)) {
          setPendingTerminalCloseTab(id);
          return;
        }
      }
      disposeTabs([id]);
    },
    [getTabs, disposeTabs],
  );

  const confirmClose = useCallback(() => {
    if (pendingCloseTab !== null) {
      disposeTabs([pendingCloseTab]);
      setPendingCloseTab(null);
    }
  }, [pendingCloseTab, disposeTabs]);

  const cancelClose = useCallback(() => {
    setPendingCloseTab(null);
  }, []);

  const confirmTerminalClose = useCallback(() => {
    if (pendingTerminalCloseTab !== null)
      disposeTabs([pendingTerminalCloseTab]);
    setPendingTerminalCloseTab(null);
  }, [pendingTerminalCloseTab, disposeTabs]);

  const cancelTerminalClose = useCallback(() => {
    setPendingTerminalCloseTab(null);
  }, []);

  const confirmDeleteClose = useCallback(() => {
    if (pendingDeleteTabs !== null) {
      disposeTabs(pendingDeleteTabs);
      setPendingDeleteTabs(null);
    }
  }, [pendingDeleteTabs, disposeTabs]);

  const cancelDeleteClose = useCallback(() => {
    setPendingDeleteTabs(null);
  }, []);

  const handleCloseAllTabs = useCallback(async () => {
    if (closeAllInProgress.current) return;
    const snapshot = getTabs();
    if (snapshot.length === 0) return;

    closeAllInProgress.current = true;
    setCloseAll("checking");
    const targetIds = new Set(snapshot.map((tab) => tab.id));
    const terminalIds = snapshot.flatMap((tab) =>
      tab.kind === "terminal" ? [tab.id] : [],
    );
    const checks = await Promise.allSettled(
      terminalIds.map(terminalNeedsCloseConfirmation),
    );
    const liveTabs = getTabs();
    const targets = liveTabs.filter((tab) => targetIds.has(tab.id));
    const liveIds = new Set(targets.map((tab) => tab.id));
    const terminalsToConfirm = checks.filter(
      (check, index) =>
        liveIds.has(terminalIds[index]) &&
        (check.status === "rejected" || check.value),
    ).length;
    // 检查期间新开的视图可能仍持有同一文档，按最新状态计算实际丢失的内容。
    const { dirtyDocuments } = tabCloseDocuments(
      liveTabs,
      (tab) => targetIds.has(tab.id),
      currentWorkspaceEnv(),
    );
    const tabIds = targets.map((tab) => tab.id);
    if (dirtyDocuments > 0 || terminalsToConfirm > 0) {
      setCloseAll({
        tabIds,
        spaces: new Set(targets.map((tab) => tab.spaceId)).size,
        dirtyDocuments,
        terminalsToConfirm,
      });
      return;
    }
    closeAllInProgress.current = false;
    setCloseAll(null);
    if (tabIds.length > 0) disposeTabs(tabIds);
  }, [disposeTabs, getTabs]);

  const cancelCloseAllTabs = useCallback(() => {
    closeAllInProgress.current = false;
    setCloseAll(null);
  }, []);

  const confirmCloseAllTabs = useCallback(() => {
    if (!closeAllInProgress.current || !closeAll || closeAll === "checking")
      return;
    cancelCloseAllTabs();
    disposeTabs(closeAll.tabIds);
  }, [cancelCloseAllTabs, closeAll, disposeTabs]);

  const handlePathDeleted = useCallback(
    (path: string) => {
      const dirty: number[] = [];
      const clean: number[] = [];
      for (const t of getTabs()) {
        if (t.kind !== "editor" && t.kind !== "markdown") continue;
        if (t.path !== path && !t.path.startsWith(`${path}/`)) continue;
        if (t.dirty) {
          dirty.push(t.id);
        } else {
          clean.push(t.id);
        }
      }
      if (clean.length > 0) disposeTabs(clean);
      if (dirty.length > 0) setPendingDeleteTabs(dirty);
    },
    [disposeTabs, getTabs],
  );

  return {
    pendingCloseTab,
    pendingTerminalCloseTab,
    pendingDeleteTabs,
    handleClose,
    confirmClose,
    cancelClose,
    confirmTerminalClose,
    cancelTerminalClose,
    confirmDeleteClose,
    cancelDeleteClose,
    checkingAllTabs: closeAll === "checking",
    pendingCloseAllTabs: closeAll === "checking" ? null : closeAll,
    handleCloseAllTabs,
    cancelCloseAllTabs,
    confirmCloseAllTabs,
    handlePathDeleted,
  };
}

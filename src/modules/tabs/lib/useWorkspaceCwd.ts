/** 按 Space 解析目录跟随，锁定根不干预终端 cwd 和已有运行实例。 */
import type { Tab, TerminalTab, WorkbenchState } from "@/modules/workbench";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import { useCallback, useEffect, useMemo, useRef } from "react";

type Result = {
  explorerRoot: string | null;
  inheritedCwdForNewTab: () => string | undefined;
  cwdForNewTabInSpace: (spaceId: string) => string | undefined;
  rootForSpace: (spaceId: string) => string | null;
};

export function resolveExplorerRoot(
  activeTab: Tab | undefined,
  tabs: Tab[],
  lastTerminalCwd: string | null,
  home: string | null,
): string | null {
  if (activeTab?.kind === "terminal" && activeTab.cwd) return activeTab.cwd;
  if (
    (activeTab?.kind === "editor" || activeTab?.kind === "markdown") &&
    activeTab.explorerRoot
  ) {
    return activeTab.explorerRoot;
  }
  if (lastTerminalCwd) return lastTerminalCwd;
  const anyTerm = tabs.find((t) => t.kind === "terminal" && t.cwd);
  if (anyTerm?.kind === "terminal" && anyTerm.cwd) return anyTerm.cwd;
  return home;
}

export function useWorkspaceCwd(
  workbench: WorkbenchState,
  activeSpaceId: string | null,
  home: string | null,
): Result {
  const spaces = useSpaces((state) => state.spaces);
  const lastTerminalCwds = useRef(new Map<string, string>());
  const contexts = useMemo(() => {
    const tabsBySpace = new Map<string, Tab[]>();
    for (const tab of Object.values(workbench.tabs)) {
      const tabs = tabsBySpace.get(tab.spaceId) ?? [];
      tabs.push(tab);
      tabsBySpace.set(tab.spaceId, tabs);
    }
    return new Map(
      spaces.map((space) => {
        const layout = workbench.spaces[space.id];
        const tabId = layout?.groups[layout.activeGroupId]?.activeTabId;
        const activeTab = tabId != null ? workbench.tabs[tabId] : undefined;
        const tabs = tabsBySpace.get(space.id) ?? [];
        const last = lastTerminalCwds.current.get(space.id) ?? null;
        const explicitRoot = tabs.length
          ? resolveExplorerRoot(activeTab, tabs, last, null)
          : null;
        const root = space.rootLocked
          ? (space.root ?? explicitRoot)
          : tabs.length
            ? resolveExplorerRoot(activeTab, tabs, last, home)
            : null;
        const newTabCwd =
          activeTab?.kind === "terminal" && activeTab.cwd
            ? activeTab.cwd
            : ((tabs.length ? last : null) ??
              tabs.find(
                (tab): tab is TerminalTab =>
                  tab.kind === "terminal" && Boolean(tab.cwd),
              )?.cwd ??
              space.root ??
              home ??
              undefined);
        return [
          space.id,
          { activeTab, explicitRoot, root, newTabCwd, empty: !tabs.length },
        ] as const;
      }),
    );
  }, [spaces, workbench, home]);

  useEffect(() => {
    for (const id of lastTerminalCwds.current.keys()) {
      if (!contexts.has(id)) lastTerminalCwds.current.delete(id);
    }
    for (const space of spaces) {
      const context = contexts.get(space.id);
      if (!context) continue;
      if (context.empty) lastTerminalCwds.current.delete(space.id);
      if (context.activeTab?.kind === "terminal" && context.activeTab.cwd) {
        lastTerminalCwds.current.set(space.id, context.activeTab.cwd);
      }
      // 首次绑定只接受工作页明确提供的目录，不捕获 Home 展示回退。
      if (space.rootLocked && !space.root && context.explicitRoot) {
        useSpaces.getState().setRoot(space.id, context.explicitRoot);
      }
    }
  }, [contexts, spaces]);

  const rootForSpace = useCallback(
    (id: string) => contexts.get(id)?.root ?? null,
    [contexts],
  );
  const cwdForNewTabInSpace = useCallback(
    (id: string) => contexts.get(id)?.newTabCwd,
    [contexts],
  );
  const inheritedCwdForNewTab = useCallback(
    () =>
      activeSpaceId ? cwdForNewTabInSpace(activeSpaceId) : (home ?? undefined),
    [activeSpaceId, cwdForNewTabInSpace, home],
  );
  return {
    explorerRoot: activeSpaceId ? rootForSpace(activeSpaceId) : null,
    inheritedCwdForNewTab,
    cwdForNewTabInSpace,
    rootForSpace,
  };
}

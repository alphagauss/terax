/**
 * 本文件协调 Terax 主窗口的工作区、终端、侧栏和全局交互状态。
 * 具体业务逻辑由对应模块持有，主窗口只负责组合页面和连接跨模块事件。
 */
import { ChannelsPanel } from "@/modules/channels/components/lazy";
import { getPrimaryNavigationActiveId } from "@/app/lib/primaryNavigation";

import { ToastDismissOnClick } from "@/components/ToastDismissOnClick";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/controls/tooltip";
import { canConsumeLaunchFiles, consumeLaunchFiles } from "@/lib/launchDir";
import { useChannelsHost } from "@/modules/channels/useChannelsHost";
import { flushSharedStoreWrites } from "@/lib/sharedStore";
import { quoteShellArg } from "@/lib/shellQuote";
import { usePresence } from "@/lib/usePresence";
import { useZoom } from "@/lib/useZoom";
import { cn, isMarkdownPath } from "@/lib/utils";
import { AgentNotificationsBridge, nextAttentionTabId } from "@/modules/agents";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import { NotificationNavigationBridge } from "@/modules/notifications/NotificationNavigationBridge";
import {
  AiSidebarPanel,
  ApprovalToastHost,
  flushCompletedSessionRuns,
  LocalAgentNotificationsBridge,
  SelectionAskAi,
  useAiBootstrap,
  useAiLiveBridge,
  useChatStore,
  useSelectionAskAi,
} from "@/modules/ai";
import { AiComposerProvider } from "@/modules/ai/lib/composer";
import { native } from "@/modules/ai/lib/native";
import { buildOpenFileGroups } from "@/modules/ai/lib/openFileCandidates";
import { useApprovalStore } from "@/modules/ai/store/approvalStore";
import { useSessionAttentionStore } from "@/modules/ai/store/sessionAttentionStore";
import { useAlphaShowInRemote } from "@/modules/alpha/preferences";
import { flushAlphaDeskWrites } from "@/modules/alpha/desk/writes";
import { CommandPalette, createCommandItems } from "@/modules/command-palette";
import {
  type EditorPaneHandle,
  type EditorSourceSelection,
  discardSharedDocumentModel,
  hasOtherDocumentView,
  isDocumentTab,
  NewEditorDialog,
  saveAutoSaveDocumentsBeforeClose,
} from "@/modules/editor";
import { FileExplorer, type FileExplorerHandle } from "@/modules/explorer";
import type { FindHandle } from "@/modules/find";
import { Header } from "@/modules/header";
import { setLspNavigator } from "@/modules/lsp";
import type { MarkdownPreviewPaneHandle } from "@/modules/markdown/MarkdownPreviewPane";
import type { WebPreviewPaneHandle } from "@/modules/preview";
import {
  isPythonFile,
  PythonInterpreterDialog,
  usePythonFileRunner,
} from "@/modules/python";
import { HostKeyDialog, SshConnectionDialog } from "@/modules/remote";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setShowHidden } from "@/modules/settings/store";
import {
  type ShortcutHandlers,
  type ShortcutId,
  useGlobalShortcuts,
} from "@/modules/shortcuts";
import {
  SecondarySidebarTabs,
  SidebarActivityBar,
  type SidebarContainerId,
  type SidebarPooledView,
  SidebarViewPool,
  useSidebarLayout,
  WORKSPACE_MIN_WIDTH,
} from "@/modules/sidebar";
import {
  RepositoryProvider,
  SourceControlViewContainer,
  useSourceControlContext,
} from "@/modules/source-control";
import {
  SpaceSwitcher,
  useSpacePersistence,
  useSpaces,
  useSpacesBoot,
} from "@/modules/spaces";
import { StatusBar } from "@/modules/statusbar";
import {
  TabSwitcherHud,
  useTabSwitcher,
  useWindowTitle,
  useWorkspaceCwd,
} from "@/modules/tabs";
import {
  clearFocusedTerminal,
  disposeSession,
  navigateFocusedBlocks,
  type TerminalPaneHandle,
  terminalHasForegroundProcess,
  useTerminalFileDrop,
  writeToSession,
} from "@/modules/terminal";
import { ThemeProvider, useThemeFileEditing } from "@/modules/theme";
import {
  type ContentSearchHit,
  WorkspaceSearchPanel,
  type WorkspaceSearchPanelHandle,
} from "@/modules/workspace-search";
import {
  DEFAULT_SPACE_ID,
  findGroupForTab,
  type TerminalTab,
  tabsForActiveGroup,
  useStartupWarmup,
  useWorkbench,
  type WorkbenchChromeActions,
  WorkbenchSurface,
  type WorkbenchViewServices,
} from "@/modules/workbench";
import {
  currentWorkspaceEnv,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
} from "@/modules/workspace";
import {
  currentWorkspaceBootstrap,
  flushWorkspaceStore,
  policyForEnvironmentSelection,
  spawnWorkspaceProcess,
} from "@/modules/workspace-process";
import {
  type WorkspacePage,
  useWorkspacePageHandoff,
} from "@/modules/workspace-handoff";
import { invoke } from "@tauri-apps/api/core";
import { useSpaceDirectories } from "@/modules/spaces/lib/useSpaceDirectories";
import { SpaceDirectoryDialog } from "@/modules/spaces/components/SpaceDirectoryDialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Layout, LayoutChangedMeta } from "react-resizable-panels";
import { toast } from "sonner";
import { CloseDialogs } from "./components/CloseDialogs";
import { WorkspaceConnectionPlaceholder } from "./components/WorkspaceConnectionPlaceholder";
import { WorkspaceInputBar } from "./components/WorkspaceInputBar";
import { useAppCloseGuard } from "./hooks/useAppCloseGuard";
import { useTabCloseGuards } from "./hooks/useTabCloseGuards";
import { useWorkspaceEnvironment } from "./hooks/useWorkspaceEnvironment";
import { useZenMode } from "./hooks/useZenMode";
import { spaceDeleteDocuments } from "./lib/spaceDelete";

function parentDirectory(path: string): string | null {
  const index = path.lastIndexOf("/");
  if (index < 0) return null;
  if (index === 0) return "/";
  if (index === 2 && /^[A-Za-z]:/.test(path)) return path.slice(0, 3);
  return path.slice(0, index);
}

/**
 * Terax 主窗口组件。
 *
 * 负责组合工作区、终端和侧栏。Space 目录独立于工作页，目录选择不创建终端。
 */
export default function App() {
  const { t } = useTranslation("common");
  const revealWorkbenchSpace = useCallback((spaceId: string) => {
    useSpaces.getState().setActive(spaceId);
  }, []);
  const {
    state: workbenchState,
    tabs,
    activeId,
    setActiveId,
    warmTabInBackground,
    setActiveGroup,
    allocId,
    replaceWorkbench,
    moveTabToSpace,
    moveTabToGroup,
    reorderTab,
    reorderTabByGap,
    newTabInSpace,
    createSpace,
    removeSpace,
    closeExitedTerminal,
    booted: workbenchBooted,
    markBooted,
    setActiveSpace,
    newTab,
    newBlockTab,
    newRunTab,
    newPrivateTab,
    openFileTab,
    pinTab,
    newWebPreviewTab,
    newMarkdownTab,
    openAiDiffTab,
    openFileEditsTab,
    setAiDiffStatus,
    openGitDiffTab,
    openCommitFileDiffTab,
    openAlphaDeskTab,
    closeTab,
    updateTab,
    setDocumentDirty,
    selectByIndex,
    selectAdjacentTab,
    setTerminalCwd,
    focusGroup,
    splitTab,
    resizeSplit,
  } = useWorkbench(revealWorkbenchSpace);

  // Mirror `tabs` into a ref so callbacks scheduled with `setTimeout`
  // (e.g. cdInNewTab) read the latest Workbench state instead of a stale closure.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const getTabById = useCallback(
    (tabId: number) =>
      tabsRef.current.find((candidate) => candidate.id === tabId),
    [],
  );

  const activeTerminalTab = useMemo(() => {
    const t = tabs.find((x) => x.id === activeId);
    return t && t.kind === "terminal" ? t : null;
  }, [tabs, activeId]);
  const activeTerminalId = activeTerminalTab?.id ?? null;

  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(new Map());
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(new Map());
  const findRefs = useRef<Map<number, FindHandle>>(new Map());
  const markdownNavigationRefs = useRef(
    new Map<number, MarkdownPreviewPaneHandle>(),
  );
  const pendingContentNavigation = useRef<
    Map<
      number,
      {
        line: number;
        selection?: EditorSourceSelection;
        markdownSource?: boolean;
      }
    >
  >(new Map());
  /**
   * 将待处理定位投递给已经注册的编辑器或 Markdown 视图。
   * 已有标签由调用方立即消费，新标签则在对应 handle 注册后消费。
   */
  const applyPendingContentNavigation = useCallback((id: number) => {
    const pending = pendingContentNavigation.current.get(id);
    if (!pending) return;
    const markdownNavigation = markdownNavigationRefs.current.get(id);
    if (markdownNavigation) {
      pendingContentNavigation.current.delete(id);
      if (pending.markdownSource) {
        markdownNavigation.openSourceLocation(pending.line, pending.selection);
      } else {
        markdownNavigation.gotoSourceLine(pending.line);
      }
      return;
    }
    const editor = editorRefs.current.get(id);
    if (!editor) return;
    pendingContentNavigation.current.delete(id);
    editor.gotoLine(pending.line, pending.selection);
  }, []);
  const webPreviewRefs = useRef<Map<number, WebPreviewPaneHandle>>(new Map());
  const explorerReturnFocusRef = useRef<HTMLElement | null>(null);
  const [activeEditorHandle, setActiveEditorHandle] =
    useState<EditorPaneHandle | null>(null);
  const { zoomIn, zoomOut, zoomReset } = useZoom();
  useTerminalFileDrop();
  const explorerRef = useRef<FileExplorerHandle>(null);
  const workspaceSearchRef = useRef<WorkspaceSearchPanelHandle>(null);
  /** 禅模式隐藏当前焦点所在的界面外壳时，将焦点转移到活动工作台视图。 */
  const focusActiveWorkbench = useCallback(() => {
    const tabId = activeIdRef.current;
    const handle =
      terminalRefs.current.get(tabId) ?? editorRefs.current.get(tabId);
    if (handle) {
      handle.focus();
      return;
    }
    document
      .querySelector<HTMLElement>(`[data-workbench-tab="${tabId}"]`)
      ?.focus({ preventScroll: true });
  }, []);
  const handleZenFullscreenError = useCallback(
    (error: unknown) => {
      console.error("zen mode fullscreen transition failed:", error);
      toast.error(t("zenMode.fullscreenFailed", { ns: "app" }));
    },
    [t],
  );
  const { enabled: zenMode, toggle: toggleZenModeState } = useZenMode({
    onFullscreenError: handleZenFullscreenError,
    focusWorkbench: focusActiveWorkbench,
  });

  useEffect(() => {
    document.documentElement.toggleAttribute("data-zen-mode", zenMode);
    return () => document.documentElement.removeAttribute("data-zen-mode");
  }, [zenMode]);

  // Session disposal follows stable terminal ids, not React lifecycles.
  const liveTerminalIdsRef = useRef<Set<number>>(new Set());

  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const workspaceWindowMode = usePreferencesStore((s) => s.workspaceWindowMode);
  const {
    home,
    launchCwdResolved,
    environmentError,
    remoteEventsReady,
    credentialsRequired,
    hostPrompt,
    clearHostPrompt,
    ensureWorkspaceReady,
    reconnectWorkspace,
  } = useWorkspaceEnvironment();
  const [sshConnectionOpen, setSshConnectionOpen] = useState(false);
  useEffect(() => {
    if (credentialsRequired) setSshConnectionOpen(true);
  }, [credentialsRequired]);
  // 文件管理器、状态栏和凭据对话框共享 Hook 内的连接任务，避免并发替换 SSH Runtime。
  const requestSshReconnect = useCallback(() => {
    if (workspaceEnv.kind !== "ssh") return;
    void reconnectWorkspace().then((connectedHome) => {
      if (!connectedHome) setSshConnectionOpen(true);
    });
  }, [reconnectWorkspace, workspaceEnv.kind]);
  const workspaceBootPending =
    workspaceEnv.kind !== "local" &&
    !workbenchBooted &&
    environmentError === null;

  const activeSpaceId = useSpaces((s) => s.activeId);
  const spaces = useSpaces((s) => s.spaces);
  const spacesHydrated = useSpaces((s) => s.hydrated);
  const openFileGroups = useMemo(
    () =>
      buildOpenFileGroups({
        state: workbenchState,
        spaces,
        activeSpaceId: activeSpaceId ?? DEFAULT_SPACE_ID,
        workspace: workspaceEnv,
      }),
    [activeSpaceId, spaces, workbenchState, workspaceEnv],
  );

  const handleWorkspaceChange = useCallback(
    (env: WorkspaceEnv) => {
      const policy = policyForEnvironmentSelection(workspaceEnv, env);
      void spawnWorkspaceProcess(env, policy).catch((error) => {
        toast.error("Failed to open Workspace window", {
          description: String(error),
        });
      });
    },
    [workspaceEnv],
  );

  const openNewWindow = useCallback(() => {
    void spawnWorkspaceProcess(workspaceEnv, "fresh").catch((error) => {
      toast.error("Failed to open Workspace window", {
        description: String(error),
      });
    });
  }, [workspaceEnv]);

  useSpacesBoot({
    ready: launchCwdResolved && remoteEventsReady,
    allocId,
    replaceWorkbench,
    markBooted,
    ensureWorkspaceReady,
    environmentHome: home,
  });

  const flushSpacePersistence = useSpacePersistence({
    state: workbenchState,
    enabled: spacesHydrated,
  });

  useEffect(() => {
    if (!spacesHydrated || !activeSpaceId) return;
    setActiveSpace(activeSpaceId);
  }, [activeSpaceId, spacesHydrated, setActiveSpace]);

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const spaceTabs = useMemo(
    () =>
      tabs.filter((tab) => tab.spaceId === (activeSpaceId ?? DEFAULT_SPACE_ID)),
    [activeSpaceId, tabs],
  );
  const activeGroupTabs = useMemo(
    () => tabsForActiveGroup(workbenchState, activeSpaceId ?? DEFAULT_SPACE_ID),
    [activeSpaceId, workbenchState],
  );

  const showAlphaInRemote = useAlphaShowInRemote();
  const alphaAvailable = workspaceEnv.kind === "local" || showAlphaInRemote;
  const unavailableSidebarContainerIds = useMemo(
    () => [
      ...(!alphaAvailable ? ["alpha" as const] : []),
      ...(!currentWorkspaceBootstrap().isPrimary ||
      workspaceEnv.kind !== "local"
        ? ["channels" as const]
        : []),
    ],
    [alphaAvailable, workspaceEnv.kind],
  );
  const sidebar = useSidebarLayout(
    unavailableSidebarContainerIds,
    zenMode,
    !currentWorkspaceBootstrap().isPrimary,
  );
  const secondaryMode = sidebar.runtime.secondaryMode;
  const secondaryFocused = secondaryMode !== "normal";
  const secondaryMaximized = secondaryMode === "maximized";
  const secondaryRestoring = sidebar.restoringSecondaryMode !== null;
  const secondaryPresentationActive = secondaryFocused || secondaryRestoring;
  const primaryPresentationMaximized =
    secondaryMaximized || sidebar.restoringSecondaryMode === "maximized";
  const initialSecondaryFocused =
    sidebar.initialRuntime.secondaryMode !== "normal";
  const initialSecondaryMaximized =
    sidebar.initialRuntime.secondaryMode === "maximized";
  /** 禅模式独占工作区，进入前先结束与其冲突的副侧边栏聚焦模式。 */
  const toggleZenMode = useCallback(() => {
    if (!zenMode && sidebar.runtime.secondaryMode !== "normal") {
      sidebar.setSecondaryMode("normal");
    }
    toggleZenModeState();
  }, [
    sidebar.runtime.secondaryMode,
    sidebar.setSecondaryMode,
    toggleZenModeState,
    zenMode,
  ]);
  const openWorkspaceFromSidebar = useCallback(
    function openWorkspaceFromSidebar<Result>(
      containerId: SidebarContainerId,
      open: () => Result,
    ): Result {
      sidebar.restoreSecondaryModeForContainer(containerId);
      return open();
    },
    [sidebar.restoreSecondaryModeForContainer],
  );
  const toggleSidebar = useCallback(() => {
    sidebar.toggleLocation("primary");
  }, [sidebar.toggleLocation]);
  const toggleHiddenFiles = useCallback(() => {
    sidebar.openContainer("explorer");
    void setShowHidden(!usePreferencesStore.getState().showHidden);
  }, [sidebar.openContainer]);
  const openWorkspaceSearch = useCallback(() => {
    if (!sidebar.openContainer("search")) return;
    requestAnimationFrame(() => workspaceSearchRef.current?.focus());
  }, [sidebar.openContainer]);
  const commitWorkbenchLayout = useCallback(
    (_layout: Layout, meta: LayoutChangedMeta) => {
      if (!meta.isUserInteraction) return;
      sidebar.commitLayout();
    },
    [sidebar.commitLayout],
  );
  const [newEditorOpen, setNewEditorOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const openCommandPalette = useCallback(() => setCommandPaletteOpen(true), []);
  const focusInput = useChatStore((s) => s.focusInput);
  const setLive = useChatStore((s) => s.setLive);
  const respondApproval = useApprovalStore((state) => state.respond);

  const { hasComposer, keysLoaded } = useAiBootstrap();
  const hasActiveAiRuns = useChatStore(
    (state) => Object.keys(state.runLockSessionIds).length > 0,
  );

  const activeTab = tabs.find((t) => t.id === activeId);
  const isTerminalTab = activeTab?.kind === "terminal";
  const isBlockTab = activeTerminalTab?.blocks === true;
  const isEditorTab =
    activeTab?.kind === "editor" ||
    (activeTab?.kind === "markdown" && activeEditorHandle !== null);
  const isFindableTab =
    activeTab?.kind === "terminal" ||
    activeTab?.kind === "editor" ||
    activeTab?.kind === "markdown" ||
    activeTab?.kind === "git-diff" ||
    activeTab?.kind === "git-commit-file" ||
    activeTab?.kind === "ai-diff";

  useThemeFileEditing({ tabsRef, openFileTab });

  const {
    explorerRoot,
    inheritedCwdForNewTab,
    cwdForNewTabInSpace,
    rootForSpace,
  } = useWorkspaceCwd(workbenchState, activeSpaceId, home);
  const directories = useSpaceDirectories(createSpace, ensureWorkspaceReady);
  const updatePythonRunTitle = useCallback(
    (tabId: number, title: string) => updateTab(tabId, { title }),
    [updateTab],
  );
  const pythonRunner = usePythonFileRunner({
    workspace: workspaceEnv,
    explorerRoot,
    activeSpaceId: activeSpaceId ?? DEFAULT_SPACE_ID,
    tabsRef,
    editorRefs,
    ensureWorkspaceReady,
    newRunTab,
    activateTab: setActiveId,
    updateTabTitle: updatePythonRunTitle,
  });
  useStartupWarmup({
    enabled: workbenchBooted && spacesHydrated,
    state: workbenchState,
    activeSpaceId: activeSpaceId ?? DEFAULT_SPACE_ID,
    activeTab,
    warmTabInBackground,
  });

  useWindowTitle(activeTab);

  useEffect(() => {
    setActiveEditorHandle(editorRefs.current.get(activeId) ?? null);
  }, [activeId]);

  const disposeTab = useCallback(
    (id: number) => {
      const closing = tabsRef.current.find((tab) => tab.id === id);
      const next = closeTab(id);
      if (next.tabs[id]) return;
      if (
        closing &&
        isDocumentTab(closing) &&
        !hasOtherDocumentView(Object.values(next.tabs), closing)
      ) {
        // 最后一个视图确认关闭即释放缓冲区，避免重新打开时恢复已放弃的编辑。
        discardSharedDocumentModel(currentWorkspaceEnv(), closing.path);
      }
      // Terminal-id maps are pruned by the effect below; tab-id handles need
      // explicit cleanup here.
      editorRefs.current.delete(id);
      markdownNavigationRefs.current.delete(id);
      findRefs.current.delete(id);
      pendingContentNavigation.current.delete(id);
      webPreviewRefs.current.delete(id);
    },
    [closeTab],
  );

  const {
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
    handlePathDeleted,
  } = useTabCloseGuards({ tabs, disposeTab });
  const handleCloseRef = useRef(handleClose);
  handleCloseRef.current = handleClose;
  const requestEditorClose = useCallback((id: number) => {
    void handleCloseRef.current(id);
  }, []);

  const flushBeforeAppClose = useCallback(async () => {
    const stateResults = await Promise.allSettled([
      flushSpacePersistence(),
      flushCompletedSessionRuns(),
      flushAlphaDeskWrites(),
    ]);
    const storeResults = await Promise.allSettled([
      flushSharedStoreWrites(),
      flushWorkspaceStore(),
    ]);
    for (const result of [...stateResults, ...storeResults]) {
      if (result.status === "rejected") throw result.reason;
    }
  }, [flushSpacePersistence]);
  const { pendingAppClose, confirmAppClose, cancelAppClose } = useAppCloseGuard(
    tabsRef,
    flushBeforeAppClose,
    saveAutoSaveDocumentsBeforeClose,
  );
  const [pendingSpaceDelete, setPendingSpaceDelete] = useState<{
    spaceId: string;
    dirtyDocuments: number;
    busyTerminal: boolean;
  } | null>(null);

  useEffect(() => {
    const live = new Set<number>();
    for (const t of tabs) {
      if (t.kind === "terminal") live.add(t.id);
    }
    for (const id of liveTerminalIdsRef.current) {
      if (!live.has(id)) disposeSession(id);
    }
    liveTerminalIdsRef.current = live;
    for (const k of [...terminalRefs.current.keys()])
      if (!live.has(k)) terminalRefs.current.delete(k);
  }, [tabs]);

  useEffect(() => {
    if (alphaAvailable) return;
    for (const tab of tabsRef.current) {
      if (tab.kind === "alpha-desk") {
        disposeTab(tab.id);
      }
    }
  }, [alphaAvailable, disposeTab]);

  // Ctrl+Tab 只在当前分组中按 MRU 顺序导航，不跨越分组或 Space。
  const mruRef = useRef<number[]>([activeId]);
  useEffect(() => {
    mruRef.current = [
      activeId,
      ...mruRef.current.filter((id) => id !== activeId),
    ];
  }, [activeId]);
  useEffect(() => {
    const live = new Set(tabs.map((t) => t.id));
    mruRef.current = mruRef.current.filter((id) => live.has(id));
  }, [tabs]);

  const getRecentSwitcherOrder = useCallback(() => {
    const inGroup = activeGroupTabs.map((tab) => tab.id);
    const present = new Set(inGroup);
    const ordered = mruRef.current.filter((id) => present.has(id));
    for (const id of inGroup) if (!ordered.includes(id)) ordered.push(id);
    return [activeId, ...ordered.filter((id) => id !== activeId)];
  }, [activeGroupTabs, activeId]);

  const {
    state: switcherState,
    step: stepSwitcher,
    cancel: cancelTabSwitcher,
  } = useTabSwitcher({
    getOrder: getRecentSwitcherOrder,
    getActiveId: () => activeId,
    onCommit: (id) => {
      if (activeGroupTabs.some((tab) => tab.id === id)) setActiveId(id);
    },
  });

  useEffect(() => {
    if (
      switcherState &&
      (switcherState.initialId !== activeId ||
        !activeGroupTabs.some((tab) => tab.id === switcherState.initialId))
    ) {
      cancelTabSwitcher();
    }
  }, [activeGroupTabs, activeId, cancelTabSwitcher, switcherState]);

  const cycleSpace = useCallback((delta: 1 | -1) => {
    const { spaces, activeId: sid, setActive } = useSpaces.getState();
    if (spaces.length < 2) return;
    const idx = spaces.findIndex((s) => s.id === sid);
    const next = (idx + delta + spaces.length) % spaces.length;
    setActive(spaces[next].id);
  }, []);

  const captureActiveSelection = useCallback((): string | null => {
    const t = tabs.find((x) => x.id === activeId);
    if (!t) return null;
    if (t.kind === "terminal") {
      return terminalRefs.current.get(t.id)?.getSelection() ?? null;
    }
    if (t.kind === "editor" || t.kind === "markdown") {
      return editorRefs.current.get(activeId)?.getSelection() ?? null;
    }
    return null;
  }, [tabs, activeId]);

  const toggleExplorerFocus = useCallback(() => {
    const explorer = explorerRef.current;
    if (!sidebar.isVisible("explorer")) {
      const active = document.activeElement;
      if (!sidebar.openContainer("explorer")) return;
      explorerReturnFocusRef.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
      requestAnimationFrame(() => explorerRef.current?.focus());
      return;
    }
    if (!explorer) return;
    if (explorer.isFocused()) {
      const target = explorerReturnFocusRef.current;
      explorerReturnFocusRef.current = null;
      if (target && document.body.contains(target)) target.focus();
      else (document.activeElement as HTMLElement | null)?.blur?.();
      return;
    }
    const active = document.activeElement;
    explorerReturnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    explorer.focus();
  }, [sidebar.isVisible, sidebar.openContainer]);

  const openAiPanel = useCallback(() => {
    return sidebar.openContainer("ai");
  }, [sidebar.openContainer]);

  const openAiPanelAndFocus = useCallback(
    (prefill: string | null = null) => {
      if (!openAiPanel()) return false;
      focusInput(prefill);
      return true;
    },
    [focusInput, openAiPanel],
  );

  const toggleAiPanel = useCallback(() => {
    if (!sidebar.isVisible("ai")) {
      openAiPanelAndFocus();
    } else {
      sidebar.toggleContainer("ai");
    }
  }, [openAiPanelAndFocus, sidebar.isVisible, sidebar.toggleContainer]);

  const attachSelection = useChatStore((s) => s.attachSelection);
  const attachFile = useChatStore((s) => s.attachFile);

  const handleAttachFileToAgent = useCallback(
    (path: string) => {
      if (!openAiPanelAndFocus()) return;
      attachFile(path);
    },
    [attachFile, openAiPanelAndFocus],
  );

  const askFromSelection = useCallback(() => {
    const selection = captureActiveSelection();
    if (!selection?.trim()) {
      openAiPanelAndFocus();
      return;
    }
    if (!openAiPanel()) return;
    const tab = tabs.find((item) => item.id === activeId);
    if (tab?.kind === "editor" || tab?.kind === "markdown") {
      attachSelection({ text: selection, source: "editor", path: tab.path });
    } else {
      attachSelection({ text: selection, source: "terminal" });
    }
  }, [
    captureActiveSelection,
    openAiPanel,
    openAiPanelAndFocus,
    attachSelection,
    activeId,
    tabs,
  ]);

  const { askPopup, setAskPopup, onAskFromSelection } = useSelectionAskAi({
    captureActiveSelection,
    askFromSelection,
  });
  const askPresence = usePresence(Boolean(askPopup), 120);

  const activeFindHandle = useCallback((): FindHandle | null => {
    const tabId = activeIdRef.current;
    const registered = findRefs.current.get(tabId);
    if (registered) return registered;
    const editor = editorRefs.current.get(tabId);
    if (editor) return editor;
    const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
    if (tab?.kind === "terminal") {
      return terminalRefs.current.get(tab.id) ?? null;
    }
    return null;
  }, []);

  const focusFind = useCallback(() => {
    setAskPopup(null);
    activeFindHandle()?.open();
  }, [activeFindHandle, setAskPopup]);

  /** 环境就绪后创建指定类型的终端页面，Home 只作为缺省 cwd。 */
  const openTerminalPage = useCallback(
    async (
      kind: "terminal" | "block" | "private",
      cwd?: string,
      groupId?: number,
    ) => {
      const readyHome = await ensureWorkspaceReady();
      if (!readyHome) return null;
      const targetCwd = cwd ?? readyHome;
      if (kind === "block") return newBlockTab(targetCwd, groupId);
      if (kind === "private") return newPrivateTab(targetCwd, groupId);
      return newTab(targetCwd, groupId);
    },
    [ensureWorkspaceReady, newBlockTab, newPrivateTab, newTab],
  );

  const openNewTab = useCallback(
    () => openTerminalPage("terminal", inheritedCwdForNewTab()),
    [inheritedCwdForNewTab, openTerminalPage],
  );

  /** 在环境就绪后打开新建文件对话框，避免空远端 Workspace 被动连接。 */
  const openNewEditor = useCallback(async () => {
    if (!(await ensureWorkspaceReady())) return;
    setNewEditorOpen(true);
  }, [ensureWorkspaceReady]);

  /** 目录选择绑定发起操作时的 Space；Default 的选择始终创建项目 Space。 */
  const openFolder = useCallback(
    () => directories.chooseDirectory(activeSpaceId),
    [directories.chooseDirectory, activeSpaceId],
  );

  const openEnvironmentHome = useCallback(async () => {
    const target = activeSpaceId;
    const readyHome = await ensureWorkspaceReady();
    if (readyHome) await directories.openDirectory(readyHome, target);
  }, [activeSpaceId, ensureWorkspaceReady, directories.openDirectory]);

  const openEnvironmentPath = useCallback(
    (path: string) => directories.openDirectory(path, activeSpaceId),
    [activeSpaceId, directories.openDirectory],
  );

  const openNewPrivateTab = useCallback(
    () => openTerminalPage("private", inheritedCwdForNewTab()),
    [inheritedCwdForNewTab, openTerminalPage],
  );

  const openNewBlockTab = useCallback(
    () => openTerminalPage("block", inheritedCwdForNewTab()),
    [inheritedCwdForNewTab, openTerminalPage],
  );

  const sendCd = useCallback(
    (path: string) => {
      if (activeTerminalId === null) return;
      const term = terminalRefs.current.get(activeTerminalId);
      if (!term) return;
      term.write(`cd ${quoteShellArg(path)}\r`);
      term.focus();
    },
    [activeTerminalId],
  );

  const cdInNewTab = useCallback(
    (path: string) => {
      const tabId = newTab(path);
      setTimeout(() => {
        const tab = tabsRef.current.find((x) => x.id === tabId);
        if (!tab || tab.kind !== "terminal") return;
        const t = terminalRefs.current.get(tab.id);
        if (!t) return;
        t.write(`cd ${quoteShellArg(path)}\r`);
        t.focus();
      }, 80);
    },
    [newTab],
  );

  const handleOpenFile = useCallback(
    (path: string, pin?: boolean) => {
      // 文件默认使用临时标签；双击等显式固定操作仍通过 pin 保留标签。
      if (isMarkdownPath(path))
        newMarkdownTab(path, pin ?? false, explorerRoot ?? undefined);
      else openFileTab(path, pin ?? false, explorerRoot ?? undefined);
    },
    [explorerRoot, openFileTab, newMarkdownTab],
  );

  const handleDropFileToWorkbench = useCallback(
    (
      path: string,
      target: Parameters<WorkbenchChromeActions["dropTab"]>[1],
    ) => {
      const groupId = target.groupId;
      const forceNew = target.kind !== "tabs" && target.zone !== "center";
      const id = isMarkdownPath(path)
        ? newMarkdownTab(
            path,
            true,
            explorerRoot ?? undefined,
            groupId,
            forceNew,
          )
        : openFileTab(path, true, explorerRoot ?? undefined, groupId, forceNew);
      if (id === null) return;
      if (target.kind === "tabs") {
        reorderTabByGap(id, target.gap);
      } else if (target.zone !== "center") {
        splitTab(id, target.zone, true, groupId);
      }
    },
    [explorerRoot, newMarkdownTab, openFileTab, reorderTabByGap, splitTab],
  );

  const openLaunchFiles = useCallback(
    async (files: string[]) => {
      for (const file of files) {
        const parent = parentDirectory(file);
        if (parent) await native.workspaceAuthorize(parent).catch(() => {});
        handleOpenFile(file, true);
      }
    },
    [handleOpenFile],
  );
  const openLaunchFilesRef = useRef(openLaunchFiles);
  openLaunchFilesRef.current = openLaunchFiles;

  useEffect(() => {
    // 启动文件只能读取一次。必须等 Space hydration 和 Workbench 恢复都结束，
    // 否则 useSpacesBoot 随后的整体替换会丢弃刚打开的文件标签。
    if (!canConsumeLaunchFiles(workbenchBooted, spacesHydrated)) return;
    void consumeLaunchFiles().then((files) =>
      openLaunchFilesRef.current(files),
    );
  }, [spacesHydrated, workbenchBooted]);

  /** 在当前 Space 的活动 Group 中重建一个跨窗口复制的工作页。 */
  const openWorkspacePage = useCallback(
    async (page: WorkspacePage) => {
      const authorize = async (...paths: Array<string | null | undefined>) => {
        for (const path of new Set(paths.filter((value) => Boolean(value)))) {
          await native.workspaceAuthorize(path as string);
        }
      };

      switch (page.kind) {
        case "terminal": {
          const id = await openTerminalPage(
            page.blocks ? "block" : "terminal",
            page.cwd,
          );
          if (id === null)
            throw new Error("Workspace environment is unavailable");
          if (page.customTitle) {
            updateTab(id, {
              title: page.customTitle,
              customTitle: page.customTitle,
            });
          }
          return;
        }
        case "editor": {
          await authorize(page.explorerRoot, parentDirectory(page.path));
          const id = openFileTab(page.path, true, page.explorerRoot);
          if (id === null) throw new Error("Editor page could not be opened");
          return;
        }
        case "markdown":
          await authorize(page.explorerRoot, parentDirectory(page.path));
          if (newMarkdownTab(page.path, true, page.explorerRoot) === null) {
            throw new Error("Markdown page could not be opened");
          }
          return;
        case "web-preview": {
          const id = newWebPreviewTab(page.url);
          if (!page.url) {
            setTimeout(
              () => webPreviewRefs.current.get(id)?.focusAddressBar(),
              0,
            );
          }
        }
      }
    },
    [
      newMarkdownTab,
      newWebPreviewTab,
      openFileTab,
      openTerminalPage,
      updateTab,
    ],
  );

  const workspacePageHandoff = useWorkspacePageHandoff({
    ready: workbenchBooted && spacesHydrated,
    windowMode: workspaceWindowMode,
    getTab: getTabById,
    openFiles: openLaunchFiles,
    openPage: openWorkspacePage,
  });

  const handlePathRenamed = useCallback(
    (from: string, to: string) => {
      for (const t of tabs) {
        if (t.kind !== "editor" && t.kind !== "markdown") continue;
        if (t.path === from) {
          const i = to.lastIndexOf("/");
          updateTab(t.id, { path: to, title: i === -1 ? to : to.slice(i + 1) });
        } else if (t.path.startsWith(`${from}/`)) {
          const suffix = t.path.slice(from.length);
          const newPath = `${to}${suffix}`;
          const i = newPath.lastIndexOf("/");
          updateTab(t.id, {
            path: newPath,
            title: i === -1 ? newPath : newPath.slice(i + 1),
          });
        }
      }
    },
    [tabs, updateTab],
  );

  const activeTerminalCwd =
    activeTab?.kind === "terminal" ? (activeTab.cwd ?? null) : null;

  const activeFilePath = (() => {
    if (activeTab?.kind === "editor" || activeTab?.kind === "markdown") {
      return activeTab.path;
    }
    if (activeTab?.kind === "git-diff") {
      if (/^([A-Za-z]:|\/|\\)/.test(activeTab.path)) return activeTab.path;
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    if (activeTab?.kind === "git-commit-file") {
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    return null;
  })();
  const explorerActiveFilePath =
    activeTab?.kind === "editor" || activeTab?.kind === "markdown"
      ? activeTab.path
      : null;
  const toggleSourceControl = useCallback(() => {
    sidebar.toggleContainer("source-control");
  }, [sidebar.toggleContainer]);
  const explorerGitDecorations = usePreferencesStore(
    (s) => s.explorerGitDecorations,
  );
  const { sourceControl } = useSourceControlContext(explorerRoot);

  const openWebPreviewTab = useCallback(
    (url: string, groupId?: number) => {
      const id = newWebPreviewTab(url, groupId);
      // Focus the address bar if the URL is empty so the user can type.
      if (!url) {
        setTimeout(() => webPreviewRefs.current.get(id)?.focusAddressBar(), 0);
      }
      return id;
    },
    [newWebPreviewTab],
  );

  const splitActiveTab = useCallback(
    (direction: "right" | "down") => {
      splitTab(activeId, direction);
    },
    [activeId, splitTab],
  );

  const handleCloseActiveTab = useCallback(() => {
    void handleClose(activeId);
  }, [activeId, handleClose]);

  // Focus an agent's tab, switching to its Space before activating its group.
  const activateAgentTarget = useCallback(
    (tabId: number) => {
      const space = tabsRef.current.find((t) => t.id === tabId)?.spaceId;
      if (space && space !== useSpaces.getState().activeId) {
        useSpaces.getState().setActive(space);
      }
      setActiveId(tabId);
    },
    [setActiveId],
  );

  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      "commandPalette.open": openCommandPalette,
      "workspaceSearch.focus": openWorkspaceSearch,
      "window.new": openNewWindow,
      "tab.new": openNewTab,
      "tab.newBlock": openNewBlockTab,
      "tab.newPrivate": openNewPrivateTab,
      "tab.newWebPreview": () => openWebPreviewTab(""),
      "tab.newEditor": () => void openNewEditor(),
      "tab.close": handleCloseActiveTab,
      "tab.next": () => stepSwitcher(1),
      "tab.prev": () => stepSwitcher(-1),
      "tab.nextPage": () => selectAdjacentTab(1),
      "tab.prevPage": () => selectAdjacentTab(-1),
      "tab.selectByIndex": (e) =>
        selectByIndex(
          parseInt(e.key, 10) - 1,
          activeSpaceId ?? DEFAULT_SPACE_ID,
        ),
      "space.next": () => cycleSpace(1),
      "space.prev": () => cycleSpace(-1),
      "space.overview": () => setSwitcherOpen(true),
      "workbench.splitRight": () => splitActiveTab("right"),
      "workbench.splitDown": () => splitActiveTab("down"),
      "workbench.focusNext": () => focusGroup(1),
      "workbench.focusPrev": () => focusGroup(-1),
      "view.sourceControl": toggleSourceControl,
      "terminal.clear": () => {
        clearFocusedTerminal();
      },
      "blocks.prev": () => navigateFocusedBlocks(-1),
      "blocks.next": () => navigateFocusedBlocks(1),
      "search.focus": focusFind,
      "ai.toggle": toggleAiPanel,
      "ai.askSelection": askFromSelection,
      "agent.focusAttention": () => {
        const tabId = nextAttentionTabId();
        if (tabId !== null) activateAgentTarget(tabId);
      },
      "settings.open": () => void openSettingsWindow(),
      "folder.open": () => void openFolder(),
      "sidebar.toggle": toggleSidebar,
      "explorer.focus": toggleExplorerFocus,
      "explorer.toggleHidden": toggleHiddenFiles,
      "view.zoomIn": zoomIn,
      "view.zoomOut": zoomOut,
      "view.zoomReset": zoomReset,
      "view.fullscreen": () => {
        void invoke("toggle_fullscreen").catch((error) =>
          console.error("toggle fullscreen failed:", error),
        );
      },
      "view.zenMode": toggleZenMode,
      "editor.undo": () => editorRefs.current.get(activeId)?.undo(),
      "editor.redo": () => editorRefs.current.get(activeId)?.redo(),
      "editor.aiComplete": () =>
        editorRefs.current.get(activeId)?.triggerAiComplete(),
      "editor.codeComplete": () =>
        editorRefs.current.get(activeId)?.triggerCodeComplete(),
    }),
    [
      activeId,
      openNewWindow,
      openCommandPalette,
      openWorkspaceSearch,
      stepSwitcher,
      selectAdjacentTab,
      cycleSpace,
      handleCloseActiveTab,
      openNewTab,
      openNewBlockTab,
      openNewEditor,
      openNewPrivateTab,
      openWebPreviewTab,
      activeSpaceId,
      selectByIndex,
      splitActiveTab,
      focusGroup,
      focusFind,
      toggleSourceControl,
      toggleAiPanel,
      askFromSelection,
      openFolder,
      toggleSidebar,
      toggleExplorerFocus,
      toggleHiddenFiles,
      zoomIn,
      zoomOut,
      zoomReset,
      toggleZenMode,
      activateAgentTarget,
    ],
  );

  const shortcutsDisabled = useCallback(
    (id: ShortcutId, e: KeyboardEvent) => {
      if (
        zenMode &&
        (id === "view.sourceControl" ||
          id === "sidebar.toggle" ||
          id === "explorer.focus" ||
          id === "ai.toggle" ||
          id === "ai.askSelection")
      ) {
        return true;
      }
      if (id === "search.focus") {
        return activeFindHandle() === null;
      }
      if (id === "folder.open") {
        return workspaceEnv.kind !== "local";
      }
      if (
        id === "editor.undo" ||
        id === "editor.redo" ||
        id === "editor.aiComplete" ||
        id === "editor.codeComplete"
      ) {
        return !isEditorTab;
      }
      if (id === "ai.askSelection") {
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        const inTerminal = !!(target as HTMLElement | null)?.closest?.(
          ".xterm",
        );
        if (!inTerminal) return false;
        const sel = captureActiveSelection();
        return !sel || !sel.trim();
      }
      if (id === "terminal.clear") {
        // Only intercept ⌘K while a terminal is focused; elsewhere let the key
        // fall through (we never preventDefault when disabled).
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        return !(target as HTMLElement | null)?.closest?.(".xterm");
      }
      if (id === "blocks.prev" || id === "blocks.next") {
        return !(activeTab?.kind === "terminal" && activeTab.blocks === true);
      }
      if (id === "sidebar.toggle") {
        // Ctrl+B is also Claude Code's "run in background" key. While a terminal
        // is focused, let Ctrl+B reach the shell/Claude instead of toggling the
        // sidebar. Ctrl+Shift+B (second binding) still toggles it from anywhere.
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        const inTerminal = !!(target as HTMLElement | null)?.closest?.(
          ".xterm",
        );
        // Only defer the plain (no-shift) Ctrl/⌘+B binding; the Shift variant
        // is the always-on toggle and is never claimed by the terminal.
        return inTerminal && !e.shiftKey;
      }
      return false;
    },
    [
      activeFindHandle,
      activeTab,
      captureActiveSelection,
      isEditorTab,
      workspaceEnv.kind,
      zenMode,
    ],
  );

  useGlobalShortcuts(shortcutHandlers, { isDisabled: shortcutsDisabled });

  const registerTerminalHandle = useCallback(
    (terminalId: number, h: TerminalPaneHandle | null) => {
      if (h) terminalRefs.current.set(terminalId, h);
      else terminalRefs.current.delete(terminalId);
    },
    [],
  );

  const registerEditorHandle = useCallback(
    (id: number, h: EditorPaneHandle | null) => {
      if (h) {
        editorRefs.current.set(id, h);
        applyPendingContentNavigation(id);
      } else {
        editorRefs.current.delete(id);
      }
      if (id === activeIdRef.current) setActiveEditorHandle(h);
    },
    [applyPendingContentNavigation],
  );

  const registerFindHandle = useCallback(
    (id: number, handle: FindHandle | null) => {
      if (handle) findRefs.current.set(id, handle);
      else findRefs.current.delete(id);
    },
    [],
  );

  const registerMarkdownNavigationHandle = useCallback(
    (id: number, handle: MarkdownPreviewPaneHandle | null) => {
      if (handle) {
        markdownNavigationRefs.current.set(id, handle);
        applyPendingContentNavigation(id);
      } else {
        markdownNavigationRefs.current.delete(id);
      }
    },
    [applyPendingContentNavigation],
  );

  const registerWebPreviewHandle = useCallback(
    (id: number, h: WebPreviewPaneHandle | null) => {
      if (h) webPreviewRefs.current.set(id, h);
      else webPreviewRefs.current.delete(id);
    },
    [],
  );

  const handleWebPreviewUrl = useCallback(
    (id: number, url: string) => updateTab(id, { url }),
    [updateTab],
  );

  const authorizedCwds = useRef(new Set<string>());
  const handleTerminalCwd = useCallback(
    (tabId: number, cwd: string) => {
      setTerminalCwd(tabId, cwd);
      if (cwd && !authorizedCwds.current.has(cwd)) {
        authorizedCwds.current.add(cwd);
        native.workspaceAuthorize(cwd).catch(() => {
          authorizedCwds.current.delete(cwd);
        });
      }
    },
    [setTerminalCwd],
  );

  const onActivateAgent = activateAgentTarget;

  const onActivateLocalAgent = useCallback(
    (sessionId?: string) => {
      if (sessionId) {
        useSessionAttentionStore.getState().requestRevealLatest(sessionId);
        useChatStore.getState().switchSession(sessionId);
      }
      openAiPanel();
    },
    [openAiPanel],
  );

  const onActivateChannel = useCallback(
    (sessionId?: string) => {
      if (sessionId) onActivateLocalAgent(sessionId);
      else sidebar.openContainer("channels");
    },
    [onActivateLocalAgent, sidebar.openContainer],
  );
  useChannelsHost(onActivateChannel, keysLoaded);

  const handleTerminalExit = useCallback(
    (tabId: number, _code: number) => {
      const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
      if (tab?.kind !== "terminal") return;
      closeExitedTerminal(tab.id);
    },
    [closeExitedTerminal],
  );

  const handleEditorDirty = useCallback(
    (id: number, dirty: boolean) => setDocumentDirty(id, dirty),
    [setDocumentDirty],
  );

  const handleRenameTab = useCallback(
    (id: number, title: string) => updateTab(id, { customTitle: title.trim() }),
    [updateTab],
  );

  const activeCwd = activeTerminalCwd;

  const handleNewSpace = directories.createSpace;

  const deleteSpace = useCallback(
    (id: string) => {
      if (id === DEFAULT_SPACE_ID) return;
      const workspace = currentWorkspaceEnv();
      const { discardPaths } = spaceDeleteDocuments(
        tabsRef.current,
        id,
        workspace,
      );
      const nextSpaceId = useSpaces.getState().remove(id);
      if (!nextSpaceId) return;
      removeSpace(id, nextSpaceId);
      if (discardPaths.length > 0) {
        void import("@/modules/editor/lib/documentModel").then(
          ({ discardSharedDocumentModel }) => {
            for (const path of discardPaths) {
              discardSharedDocumentModel(workspace, path);
            }
          },
        );
      }
    },
    [removeSpace],
  );

  const handleDeleteSpace = useCallback(
    async (id: string) => {
      if (id === DEFAULT_SPACE_ID) return;
      const terminalTabs = tabsRef.current.filter(
        (tab): tab is TerminalTab =>
          tab.spaceId === id && tab.kind === "terminal",
      );
      const busyTerminal = (
        await Promise.all(
          terminalTabs.map((tab) =>
            terminalHasForegroundProcess(tab.id).catch(() => true),
          ),
        )
      ).some(Boolean);
      const { dirtyDocuments } = spaceDeleteDocuments(
        tabsRef.current,
        id,
        currentWorkspaceEnv(),
      );
      if (dirtyDocuments > 0 || busyTerminal) {
        setPendingSpaceDelete({ spaceId: id, dirtyDocuments, busyTerminal });
        return;
      }
      deleteSpace(id);
    },
    [deleteSpace],
  );

  const confirmSpaceDelete = useCallback(() => {
    if (pendingSpaceDelete) deleteSpace(pendingSpaceDelete.spaceId);
    setPendingSpaceDelete(null);
  }, [deleteSpace, pendingSpaceDelete]);

  const cancelSpaceDelete = useCallback(() => {
    setPendingSpaceDelete(null);
  }, []);

  const handleMoveTab = useCallback(
    (tabId: number, targetSpaceId: string) => {
      if (moveTabToSpace(tabId, targetSpaceId)) {
        useSpaces.getState().setActive(targetSpaceId);
      }
    },
    [moveTabToSpace],
  );

  const handleReorderTab = useCallback(
    (tabId: number, targetTabId: number, edge: "top" | "bottom") => {
      if (reorderTab(tabId, targetTabId, edge)) {
        const target = tabsRef.current.find((x) => x.id === targetTabId);
        if (target) useSpaces.getState().setActive(target.spaceId);
      }
    },
    [reorderTab],
  );

  const handleNewTabInSpace = useCallback(
    async (spaceId: string) => {
      const readyHome = await ensureWorkspaceReady();
      if (!readyHome) return;
      if (!useSpaces.getState().spaces.some((space) => space.id === spaceId))
        return;
      newTabInSpace(spaceId, cwdForNewTabInSpace(spaceId) ?? readyHome);
    },
    [ensureWorkspaceReady, newTabInSpace, cwdForNewTabInSpace],
  );

  const jumpToTab = useCallback(
    (tabId: number) => {
      const t = tabsRef.current.find((x) => x.id === tabId);
      if (!t) return;
      setActiveId(tabId);
      useSpaces.getState().setActive(t.spaceId);
      setSwitcherOpen(false);
    },
    [setActiveId],
  );

  const spaceSwitcher = (
    <SpaceSwitcher
      open={switcherOpen}
      onOpenChange={setSwitcherOpen}
      tabs={tabs}
      onNewSpace={() => void handleNewSpace()}
      onNewSpaceFromDirectory={() => {
        setSwitcherOpen(false);
        void directories.chooseDirectory(null);
      }}
      onToggleRootLock={(id) => {
        const space = useSpaces
          .getState()
          .spaces.find((item) => item.id === id);
        if (space)
          useSpaces
            .getState()
            .setRootLocked(id, !space.rootLocked, rootForSpace(id));
      }}
      onDeleteSpace={handleDeleteSpace}
      onNewTabInSpace={handleNewTabInSpace}
      onJumpTab={jumpToTab}
      onCloseTab={handleClose}
      onMoveTabToSpace={handleMoveTab}
      onReorderTab={handleReorderTab}
      onReorderSpaces={(ids) => useSpaces.getState().reorder(ids)}
    />
  );

  const commandPaletteItems = useMemo(
    () =>
      commandPaletteOpen
        ? createCommandItems({
            tabs,
            activeId,
            canFind: isFindableTab,
            explorerRoot,
            home,
            openNewWindow,
            workspaceWindowMode,
            openNewTab,
            openNewBlock: openNewBlockTab,
            openNewPrivate: openNewPrivateTab,
            openNewEditor: () => void openNewEditor(),
            openNewWebPreview: () => openWebPreviewTab(""),
            toggleSourceControl,
            closeActiveTab: handleCloseActiveTab,
            splitGroupRight: () => splitActiveTab("right"),
            splitGroupDown: () => splitActiveTab("down"),
            focusSearch: focusFind,
            openWorkspaceSearch,
            focusExplorerSearch: () => explorerRef.current?.focusSearch(),
            toggleSidebar,
            toggleHiddenFiles,
            setActivityBarPosition: sidebar.setActivityBarPosition,
            setActivityBarSize: sidebar.setActivityBarSize,
            toggleAi: toggleAiPanel,
            askAiSelection: askFromSelection,
            openSettings: () => void openSettingsWindow(),
            openKeyboardShortcuts: () => void openSettingsWindow("shortcuts"),
            spaces: useSpaces
              .getState()
              .spaces.map((space) =>
                space.id === DEFAULT_SPACE_ID
                  ? { ...space, name: t("spaces:defaultSpace") }
                  : space,
              ),
            activeSpaceId,
            openSpacesOverview: () => setSwitcherOpen(true),
            newSpace: () => void handleNewSpace(),
            switchSpace: (id) => useSpaces.getState().setActive(id),
          })
        : [],
    [
      t,
      commandPaletteOpen,
      tabs,
      activeId,
      isFindableTab,
      explorerRoot,
      home,
      openNewWindow,
      workspaceWindowMode,
      openNewTab,
      openNewBlockTab,
      openNewEditor,
      openNewPrivateTab,
      openWebPreviewTab,
      toggleSourceControl,
      handleCloseActiveTab,
      splitActiveTab,
      focusFind,
      openWorkspaceSearch,
      toggleSidebar,
      toggleHiddenFiles,
      sidebar.setActivityBarPosition,
      sidebar.setActivityBarSize,
      toggleAiPanel,
      askFromSelection,
      activeSpaceId,
      handleNewSpace,
    ],
  );

  const openContentHit = useCallback(
    (
      path: string,
      line: number,
      selection?: EditorSourceSelection,
      {
        temporary = false,
        markdownSource = false,
      }: {
        temporary?: boolean;
        markdownSource?: boolean;
      } = {},
    ) => {
      const markdown = isMarkdownPath(path);
      const root = explorerRoot ?? undefined;
      const id = markdown
        ? newMarkdownTab(path, !temporary, root)
        : openFileTab(path, !temporary, root);
      if (id == null) return;
      pendingContentNavigation.current.set(id, {
        line,
        selection,
        markdownSource: markdown && markdownSource,
      });
      applyPendingContentNavigation(id);
    },
    [applyPendingContentNavigation, explorerRoot, newMarkdownTab, openFileTab],
  );

  useEffect(() => {
    setLspNavigator({ openFile: openContentHit });
    return () => setLspNavigator(null);
  }, [openContentHit]);

  const insertHistoryCommand = useMemo(
    () =>
      isTerminalTab && activeTerminalId !== null
        ? (cmd: string) => {
            writeToSession(activeTerminalId, cmd);
            terminalRefs.current.get(activeTerminalId)?.focus();
          }
        : null,
    [isTerminalTab, activeTerminalId],
  );

  useAiLiveBridge({
    openFileReference: (path, line) =>
      openWorkspaceFromSidebar("ai", () => {
        if (line === undefined) handleOpenFile(path, false);
        else openContentHit(path, line, undefined, { temporary: true });
      }),
    openFileEdits: (input) =>
      openWorkspaceFromSidebar("ai", () => openFileEditsTab(input)),
    setLive,
    activeId,
    activeSpaceId,
    tabs,
    explorerRoot,
    environmentHome: home,
    visible: sidebar.isVisible("ai"),
    setActiveId: (tabId) =>
      openWorkspaceFromSidebar("ai", () => setActiveId(tabId)),
    newTab: (cwd) => openWorkspaceFromSidebar("ai", () => newTab(cwd)),
    ensureWorkspaceReady,
    terminalRefs,
  });

  const handleDropTab = useCallback(
    (
      tabId: number,
      target: Parameters<WorkbenchChromeActions["dropTab"]>[1],
    ) => {
      if (target.kind === "tabs") {
        const owner = findGroupForTab(workbenchState, tabId);
        if (owner?.group.id === target.groupId) {
          reorderTabByGap(tabId, target.gap);
        } else {
          moveTabToGroup(tabId, target.groupId, target.gap);
        }
        return;
      }
      if (target.zone === "center") {
        moveTabToGroup(tabId, target.groupId);
      } else {
        splitTab(tabId, target.zone, true, target.groupId);
      }
    },
    [moveTabToGroup, reorderTabByGap, splitTab, workbenchState],
  );

  const groupCwd = useCallback(
    (groupId: number) => {
      const space = workbenchState.spaces[activeSpaceId ?? DEFAULT_SPACE_ID];
      const activeGroupTabId = space?.groups[groupId]?.activeTabId;
      const tab =
        activeGroupTabId === null || activeGroupTabId === undefined
          ? undefined
          : workbenchState.tabs[activeGroupTabId];
      return tab?.kind === "terminal" ? tab.cwd : inheritedCwdForNewTab();
    },
    [activeSpaceId, inheritedCwdForNewTab, workbenchState],
  );

  const workbenchActions = useMemo<WorkbenchChromeActions>(
    () => ({
      selectTab: setActiveId,
      activateGroup: setActiveGroup,
      newTerminal: (groupId) =>
        void openTerminalPage("terminal", groupCwd(groupId), groupId),
      newBlock: (groupId) =>
        void openTerminalPage("block", groupCwd(groupId), groupId),
      newPrivate: (groupId) =>
        void openTerminalPage("private", groupCwd(groupId), groupId),
      newWebPreview: (groupId) => openWebPreviewTab("", groupId),
      newEditor: (groupId) => {
        setActiveGroup(groupId);
        void openNewEditor();
      },
      closeTab: (tabId) => void handleClose(tabId),
      runPythonFile: pythonRunner.runTab,
      attachFileToAgent: handleAttachFileToAgent,
      pinTab,
      renameTab: handleRenameTab,
      dropTab: handleDropTab,
      splitTab: (tabId, direction, move) =>
        void splitTab(tabId, direction, move),
      resizeSplit,
      ...(workspacePageHandoff && { pageHandoff: workspacePageHandoff }),
    }),
    [
      handleClose,
      handleDropTab,
      handleAttachFileToAgent,
      handleRenameTab,
      groupCwd,
      openNewEditor,
      openTerminalPage,
      openWebPreviewTab,
      pinTab,
      resizeSplit,
      pythonRunner.runTab,
      setActiveGroup,
      setActiveId,
      splitTab,
      workspacePageHandoff,
    ],
  );

  const workbenchServices = useMemo<WorkbenchViewServices>(
    () => ({
      registerTerminalHandle,
      onTerminalCwd: handleTerminalCwd,
      onTerminalExit: handleTerminalExit,
      onFocusTab: setActiveId,
      registerEditorHandle,
      registerMarkdownNavigationHandle,
      registerFindHandle,
      onFileReferenceOpen: (path, line) => {
        if (line === undefined) handleOpenFile(path, false);
        else openContentHit(path, line, undefined, { temporary: true });
      },
      onFileReferenceOpenDirectory: async (path) => {
        await directories.openDirectory(path, null);
      },
      onEditorDirtyChange: handleEditorDirty,
      onEditorCloseTab: requestEditorClose,
      registerWebPreviewHandle,
      onWebPreviewUrlChange: handleWebPreviewUrl,
      onAiDiffAccept: (key) => {
        if (respondApproval(key, true)) setAiDiffStatus(key, "approved");
      },
      onAiDiffReject: (key) => {
        if (respondApproval(key, false)) setAiDiffStatus(key, "rejected");
      },
    }),
    [
      handleEditorDirty,
      handleOpenFile,
      handleWebPreviewUrl,
      handleTerminalCwd,
      handleTerminalExit,
      directories.openDirectory,
      registerEditorHandle,
      registerFindHandle,
      registerMarkdownNavigationHandle,
      registerWebPreviewHandle,
      registerTerminalHandle,
      requestEditorClose,
      respondApproval,
      setAiDiffStatus,
      setActiveId,
      openContentHit,
    ],
  );

  const visibleSidebarContainerIds = new Set(
    sidebar.containers
      .filter(
        (container) =>
          !sidebar.activityBar.hiddenContainerIds.includes(container.id),
      )
      .map((container) => container.id),
  );
  for (const location of ["primary", "secondary"] as const) {
    const current = sidebar.runtime[location];
    if (!current.collapsed && current.activeId) {
      visibleSidebarContainerIds.add(current.activeId);
    }
  }
  const primarySidebarContainers = sidebar.placements.primary
    .map((id) => sidebar.containers.find((container) => container.id === id))
    .filter(
      (container): container is (typeof sidebar.containers)[number] =>
        container !== undefined && visibleSidebarContainerIds.has(container.id),
    );
  const secondarySidebarContainers = sidebar.placements.secondary
    .map((id) => sidebar.containers.find((container) => container.id === id))
    .filter(
      (container): container is (typeof sidebar.containers)[number] =>
        container !== undefined && visibleSidebarContainerIds.has(container.id),
    );
  /** Alpha 入口只聚焦工作页；折叠侧栏不改变上次使用的侧栏内容。 */
  const activatePrimaryNavigation = (id: SidebarContainerId) => {
    if (id === "alpha") {
      if (sidebar.runtime.secondaryMode === "maximized") {
        sidebar.setSecondaryMode("normal");
      }
      sidebar.closeLocation("primary");
      openAlphaDeskTab();
      return;
    }
    if (sidebar.activityBar.position === "default") sidebar.toggleContainer(id);
    else sidebar.openContainer(id);
  };
  const primaryNavigationActiveId = getPrimaryNavigationActiveId(
    sidebar.runtime.primary,
    activeTab?.kind,
    primarySidebarContainers,
  );
  const sidebarBadges = {
    "source-control": sourceControl.changedCount,
  };
  const sidebarConfigurationProps = {
    allContainers: sidebar.containers,
    activityBar: sidebar.activityBar,
    onToggleVisibility: sidebar.toggleContainerVisibility,
    onPositionChange: sidebar.setActivityBarPosition,
    onSizeChange: sidebar.setActivityBarSize,
  };
  const sidebarViews: readonly SidebarPooledView[] = [
    {
      id: "explorer",
      content: (
        <FileExplorer
          ref={explorerRef}
          rootPath={explorerRoot}
          active={sidebar.isVisible("explorer") && !zenMode}
          rootPending={
            workspaceBootPending
              ? workspaceEnv.kind === "ssh"
                ? "connection"
                : "loading"
              : undefined
          }
          onOpenFolder={openFolder}
          openFolderLabel={t(
            activeSpaceId === DEFAULT_SPACE_ID
              ? "spaces:newFromDirectory"
              : "spaces:changeDirectory",
          )}
          onOpenInNewSpace={(path) => {
            void directories.openDirectory(path, null);
          }}
          onOpenHome={
            workspaceEnv.kind === "local" ? undefined : openEnvironmentHome
          }
          onOpenPath={
            workspaceEnv.kind === "local" ? undefined : openEnvironmentPath
          }
          onReconnect={requestSshReconnect}
          gitStatus={explorerGitDecorations ? sourceControl.status : null}
          activeFilePath={explorerActiveFilePath}
          onOpenFile={(path, pin) =>
            openWorkspaceFromSidebar("explorer", () =>
              handleOpenFile(path, pin),
            )
          }
          onPathRenamed={handlePathRenamed}
          onPathDeleted={handlePathDeleted}
          onRevealInTerminal={(path) =>
            openWorkspaceFromSidebar("explorer", () => cdInNewTab(path))
          }
          onRunPythonFile={(path, root) =>
            openWorkspaceFromSidebar("explorer", () => {
              void pythonRunner.runFile(path, root);
            })
          }
          onAttachToAgent={handleAttachFileToAgent}
          onDropToWorkbench={handleDropFileToWorkbench}
        />
      ),
    },
    {
      id: "search",
      content: (
        <WorkspaceSearchPanel
          ref={workspaceSearchRef}
          rootPath={explorerRoot}
          visible={sidebar.isVisible("search") && !zenMode}
          onOpenHit={(hit: ContentSearchHit) =>
            openWorkspaceFromSidebar("search", () =>
              openContentHit(hit.path, hit.line, hit.ranges[0], {
                temporary: true,
                markdownSource: true,
              }),
            )
          }
        />
      ),
    },
    {
      id: "source-control",
      content: (
        <SourceControlViewContainer
          open={sidebar.isVisible("source-control")}
          sourceControl={sourceControl}
          onOpenDiff={(path) =>
            openWorkspaceFromSidebar("source-control", () =>
              openGitDiffTab(path),
            )
          }
          onOpenCommitFile={(...args) =>
            openWorkspaceFromSidebar("source-control", () =>
              openCommitFileDiffTab(...args),
            )
          }
          onOpenFile={(path) =>
            openWorkspaceFromSidebar("source-control", () =>
              handleOpenFile(path),
            )
          }
          onNavigateToPath={(path) =>
            openWorkspaceFromSidebar("source-control", () => cdInNewTab(path))
          }
        />
      ),
    },
    {
      id: "channels",
      content: (
        <ChannelsPanel visible={sidebar.isVisible("channels") && !zenMode} />
      ),
    },
    {
      id: "ai",
      content: (
        <AiSidebarPanel
          hasComposer={hasComposer}
          visible={sidebar.isVisible("ai")}
        />
      ),
    },
  ];

  const shell = (
    <ThemeProvider>
      <TooltipProvider>
        {directories.request && (
          <SpaceDirectoryDialog
            title={t(
              directories.request.spaceId &&
                directories.request.spaceId !== DEFAULT_SPACE_ID
                ? "spaces:changeDirectory"
                : "spaces:newFromDirectory",
            )}
            onClose={directories.closeDialog}
            onSubmit={directories.submitDialog}
          />
        )}
        <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
          {!zenMode && (
            <Header
              onToggleSidebar={toggleSidebar}
              onOpenCommandPalette={openCommandPalette}
              onActivateAgent={onActivateAgent}
              onActivateLocalAgent={onActivateLocalAgent}
              onOpenSettings={() => void openSettingsWindow()}
              onToggleSecondarySidebar={() =>
                sidebar.toggleLocation("secondary")
              }
              secondarySidebarOpen={!sidebar.runtime.secondary.collapsed}
              spaceSwitcher={spaceSwitcher}
            />
          )}

          <main className="zoom-content flex min-h-0 flex-1">
            {!zenMode && sidebar.activityBar.position === "default" ? (
              <SidebarActivityBar
                {...sidebarConfigurationProps}
                containers={primarySidebarContainers}
                activeId={primaryNavigationActiveId}
                badges={sidebarBadges}
                onActivate={activatePrimaryNavigation}
                onMove={sidebar.moveContainer}
                onReset={sidebar.resetContainerLocation}
              />
            ) : null}
            <ResizablePanelGroup
              orientation="horizontal"
              groupRef={sidebar.workbenchGroupRef}
              className="min-h-0 min-w-0 flex-1"
              onLayoutChanged={commitWorkbenchLayout}
            >
              <ResizablePanel
                id="primary-sidebar"
                panelRef={sidebar.panelRefs.primary}
                disabled={
                  zenMode ||
                  secondaryPresentationActive ||
                  sidebar.runtime.primary.collapsed
                }
                groupResizeBehavior="preserve-pixel-size"
                defaultSize={
                  initialSecondaryMaximized ||
                  sidebar.initialRuntime.primary.collapsed
                    ? "0px"
                    : `${sidebar.initialRuntime.primary.width}px`
                }
                minSize={
                  secondaryMaximized ||
                  (secondaryMode === "expanded" &&
                    sidebar.runtime.primary.collapsed)
                    ? "0px"
                    : `${sidebar.minimumWidth("primary")}px`
                }
                maxSize={secondaryMaximized ? "0px" : undefined}
                collapsible
                collapsedSize={0}
              >
                <div
                  data-sidebar-drop-zone="primary"
                  inert={zenMode || primaryPresentationMaximized}
                  aria-hidden={
                    zenMode || primaryPresentationMaximized || undefined
                  }
                  className={cn(
                    "sidebar-scrollbar-scope relative flex h-full min-h-0 flex-col border-r border-border/60 bg-sidebar transition-[opacity,translate] duration-pane ease-standard",
                    primaryPresentationMaximized && "invisible",
                    sidebar.runtime.primary.collapsed
                      ? "pointer-events-none -translate-x-1.5 opacity-0"
                      : "translate-x-0 opacity-100",
                  )}
                >
                  {sidebar.activityBar.position === "top" ? (
                    <SidebarActivityBar
                      {...sidebarConfigurationProps}
                      containers={primarySidebarContainers}
                      activeId={primaryNavigationActiveId}
                      badges={sidebarBadges}
                      onActivate={activatePrimaryNavigation}
                      onMove={sidebar.moveContainer}
                      onReset={sidebar.resetContainerLocation}
                    />
                  ) : null}
                  <div
                    data-sidebar-view-host="primary"
                    className="relative min-h-0 flex-1"
                  />
                  {sidebar.activityBar.position === "bottom" ? (
                    <SidebarActivityBar
                      {...sidebarConfigurationProps}
                      containers={primarySidebarContainers}
                      activeId={primaryNavigationActiveId}
                      badges={sidebarBadges}
                      onActivate={activatePrimaryNavigation}
                      onMove={sidebar.moveContainer}
                      onReset={sidebar.resetContainerLocation}
                    />
                  ) : null}
                </div>
              </ResizablePanel>
              <ResizableHandle
                withHandle
                className={cn(
                  (zenMode || secondaryPresentationActive) && "hidden",
                )}
                disabled={
                  zenMode ||
                  secondaryPresentationActive ||
                  sidebar.runtime.primary.collapsed
                }
              />
              <ResizablePanel
                id="workspace"
                defaultSize={initialSecondaryFocused ? "0px" : "78%"}
                minSize={secondaryFocused ? "0px" : `${WORKSPACE_MIN_WIDTH}px`}
                maxSize={secondaryFocused ? "0px" : undefined}
              >
                <div
                  inert={secondaryPresentationActive}
                  aria-hidden={secondaryPresentationActive || undefined}
                  className={cn(
                    "flex h-full min-h-0 flex-col",
                    secondaryPresentationActive && "invisible",
                  )}
                >
                  {workspaceBootPending ? (
                    <WorkspaceConnectionPlaceholder
                      kind={workspaceEnv.kind === "wsl" ? "wsl" : "ssh"}
                    />
                  ) : (
                    <>
                      <div className="relative min-h-0 flex-1">
                        <WorkbenchSurface
                          state={workbenchState}
                          activeSpaceId={activeSpaceId ?? DEFAULT_SPACE_ID}
                          actions={workbenchActions}
                          services={workbenchServices}
                          hideTabBars={zenMode}
                        />
                      </div>

                      <WorkspaceInputBar
                        isBlockTab={isBlockTab}
                        isTerminalTab={isTerminalTab}
                        terminalId={activeTerminalId}
                        cwd={activeCwd}
                        home={home}
                      />
                    </>
                  )}
                </div>
              </ResizablePanel>
              <ResizableHandle
                withHandle
                className={cn(
                  (zenMode || secondaryPresentationActive) && "hidden",
                )}
                disabled={
                  zenMode ||
                  secondaryPresentationActive ||
                  sidebar.runtime.secondary.collapsed
                }
              />
              <ResizablePanel
                id="secondary-sidebar"
                panelRef={sidebar.panelRefs.secondary}
                disabled={
                  zenMode ||
                  secondaryPresentationActive ||
                  sidebar.runtime.secondary.collapsed
                }
                groupResizeBehavior={
                  secondaryPresentationActive
                    ? "preserve-relative-size"
                    : "preserve-pixel-size"
                }
                defaultSize={
                  initialSecondaryFocused
                    ? "100%"
                    : sidebar.initialRuntime.secondary.collapsed
                      ? "0px"
                      : `${sidebar.initialRuntime.secondary.width}px`
                }
                minSize={`${sidebar.minimumWidth("secondary")}px`}
                collapsible
                collapsedSize={0}
              >
                <div
                  inert={zenMode}
                  aria-hidden={zenMode || undefined}
                  className={cn(
                    "h-full min-h-0 transition-[opacity,translate] duration-pane ease-standard",
                    sidebar.runtime.secondary.collapsed
                      ? "pointer-events-none translate-x-1.5 opacity-0"
                      : "translate-x-0 opacity-100",
                  )}
                >
                  <aside
                    data-sidebar-drop-zone="secondary"
                    className="sidebar-scrollbar-scope flex h-full min-h-0 flex-col border-l border-border/60 bg-sidebar"
                  >
                    {sidebar.activityBar.position !== "bottom" ? (
                      <SecondarySidebarTabs
                        {...sidebarConfigurationProps}
                        containers={secondarySidebarContainers}
                        activeId={sidebar.runtime.secondary.activeId}
                        badges={sidebarBadges}
                        onActivate={sidebar.openContainer}
                        onMove={sidebar.moveContainer}
                        onReset={sidebar.resetContainerLocation}
                        secondaryMode={secondaryMode}
                        onToggleMode={sidebar.toggleSecondaryMode}
                        onClose={() => sidebar.closeLocation("secondary")}
                      />
                    ) : null}
                    <div
                      data-sidebar-view-host="secondary"
                      className="relative min-h-0 flex-1"
                    />
                    {sidebar.activityBar.position === "bottom" ? (
                      <SecondarySidebarTabs
                        {...sidebarConfigurationProps}
                        containers={secondarySidebarContainers}
                        activeId={sidebar.runtime.secondary.activeId}
                        badges={sidebarBadges}
                        onActivate={sidebar.openContainer}
                        onMove={sidebar.moveContainer}
                        onReset={sidebar.resetContainerLocation}
                        secondaryMode={secondaryMode}
                        onToggleMode={sidebar.toggleSecondaryMode}
                        onClose={() => sidebar.closeLocation("secondary")}
                      />
                    ) : null}
                  </aside>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
            <SidebarViewPool
              views={sidebarViews}
              placements={sidebar.placements}
              runtime={sidebar.runtime}
              temporarilyHidden={zenMode}
            />
          </main>

          {!zenMode && (
            <StatusBar
              cwd={activeCwd}
              filePath={activeFilePath}
              home={home}
              workspaceError={environmentError}
              onWorkspaceRetry={ensureWorkspaceReady}
              onWorkspaceReconnect={requestSshReconnect}
              onCd={sendCd}
              onWorkspaceChange={handleWorkspaceChange}
              onToggleAi={toggleAiPanel}
              aiOpen={sidebar.isVisible("ai")}
              privateActive={
                activeTab?.kind === "terminal" && activeTab.private === true
              }
              pythonFileActive={
                activeTab?.kind === "editor" &&
                isPythonFile(activeTab.path) &&
                explorerRoot !== null
              }
              pythonInterpreter={pythonRunner.interpreter}
              onSelectPython={pythonRunner.openSelector}
            />
          )}

          <AgentNotificationsBridge
            tabs={tabs}
            activeId={activeId}
            onActivate={onActivateAgent}
          />
          <NotificationNavigationBridge
            onActivate={(target) => {
              if (target.module === "terminal") {
                useAgentStore.getState().dismissNotificationsForTarget({
                  source: "terminal",
                  tabId: target.tabId,
                });
                if (
                  tabsRef.current.some(
                    (tab) => tab.id === target.tabId && tab.kind === "terminal",
                  )
                ) {
                  onActivateAgent(target.tabId);
                }
              } else if (target.module === "ai") {
                useAgentStore.getState().dismissNotificationsForTarget({
                  source: "local",
                  sessionId: target.sessionId,
                });
                if (
                  useChatStore
                    .getState()
                    .sessions.some((session) => session.id === target.sessionId)
                ) {
                  onActivateLocalAgent(target.sessionId);
                }
              }
            }}
          />
          <HostKeyDialog prompt={hostPrompt} onResolved={clearHostPrompt} />
          <SshConnectionDialog
            open={sshConnectionOpen}
            onOpenChange={setSshConnectionOpen}
            profileId={
              workspaceEnv.kind === "ssh" ? workspaceEnv.profileId : null
            }
            onConnect={reconnectWorkspace}
          />
          <PythonInterpreterDialog
            open={pythonRunner.pickerRequest !== null}
            onOpenChange={(open) => {
              if (!open) pythonRunner.closeSelector();
            }}
            root={pythonRunner.pickerRequest?.root ?? null}
            workspace={workspaceEnv}
            selectedPath={pythonRunner.selectedPath}
            onSelect={pythonRunner.selectInterpreter}
          />
          <ToastDismissOnClick />
          <Toaster
            position="bottom-right"
            duration={3000}
            closeButton
            toastOptions={{ closeButtonAriaLabel: t("close") }}
          />

          {hasComposer || hasActiveAiRuns ? (
            <>
              <ApprovalToastHost
                openDiff={openAiDiffTab}
                onResolved={setAiDiffStatus}
              />
              <LocalAgentNotificationsBridge
                visible={sidebar.isVisible("ai")}
                onActivate={onActivateLocalAgent}
              />
            </>
          ) : null}
          {askPresence.mounted ? (
            <SelectionAskAi
              state={askPresence.state}
              x={askPopup?.x ?? 0}
              y={askPopup?.y ?? 0}
              onAsk={onAskFromSelection}
              onDismiss={() => setAskPopup(null)}
            />
          ) : null}

          {switcherState && (
            <TabSwitcherHud tabs={spaceTabs} state={switcherState} />
          )}
          <CommandPalette
            open={commandPaletteOpen}
            onOpenChange={setCommandPaletteOpen}
            commandItems={commandPaletteItems}
            insertCommand={insertHistoryCommand}
          />

          <NewEditorDialog
            open={newEditorOpen}
            onOpenChange={setNewEditorOpen}
            rootPath={explorerRoot ?? home}
            onCreated={(path) => handleOpenFile(path, true)}
          />

          <CloseDialogs
            tabs={tabs}
            pendingCloseTab={pendingCloseTab}
            onCancelClose={cancelClose}
            onConfirmClose={confirmClose}
            pendingTerminalCloseTab={pendingTerminalCloseTab}
            onCancelTerminalClose={cancelTerminalClose}
            onConfirmTerminalClose={confirmTerminalClose}
            pendingDeleteTabs={pendingDeleteTabs}
            onCancelDeleteClose={cancelDeleteClose}
            onConfirmDeleteClose={confirmDeleteClose}
            pendingAppClose={pendingAppClose}
            onCancelAppClose={cancelAppClose}
            onConfirmAppClose={confirmAppClose}
            pendingSpaceDelete={pendingSpaceDelete}
            onCancelSpaceDelete={cancelSpaceDelete}
            onConfirmSpaceDelete={confirmSpaceDelete}
          />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );

  return (
    <AiComposerProvider openFileGroups={openFileGroups}>
      <RepositoryProvider controller={sourceControl}>
        {shell}
      </RepositoryProvider>
    </AiComposerProvider>
  );
}

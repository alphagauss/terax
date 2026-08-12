/**
 * 本文件协调 Terax 主窗口的工作区、终端、侧栏和全局交互状态。
 * 具体业务逻辑由对应模块持有，主窗口只负责组合页面和连接跨模块事件。
 */

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ToastDismissOnClick } from "@/components/ToastDismissOnClick";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { consumeLaunchFiles, consumeWorkspaceOpenFiles } from "@/lib/launchDir";
import {
  flushSharedStoreWrites,
  onSharedStoreChange,
  readSharedStore,
} from "@/lib/sharedStore";
import { quoteShellArg } from "@/lib/shellQuote";
import { usePresence } from "@/lib/usePresence";
import { useZoom } from "@/lib/useZoom";
import { cn, isMarkdownPath } from "@/lib/utils";
import { AgentNotificationsBridge, nextAttentionTabId } from "@/modules/agents";
import {
  AgentRunBridge,
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
import { useApprovalStore } from "@/modules/ai/store/approvalStore";
import { useSessionAttentionStore } from "@/modules/ai/store/sessionAttentionStore";
import { CommandPalette, createCommandItems } from "@/modules/command-palette";
import {
  type EditorPaneHandle,
  hasOtherDocumentView,
  isDocumentTab,
  NewEditorDialog,
  saveAutoSaveDocumentsBeforeClose,
  useEditorFileSync,
} from "@/modules/editor";
import {
  FileExplorer,
  type FileExplorerHandle,
  useExplorerDirectoryPrefetch,
} from "@/modules/explorer";
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
import {
  type ShortcutHandlers,
  type ShortcutId,
  useGlobalShortcuts,
} from "@/modules/shortcuts";
import {
  SecondarySidebarTabs,
  SidebarActivityBar,
  SidebarViewPool,
  type SidebarPooledView,
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
  whenSessionReady,
  writeToSession,
} from "@/modules/terminal";
import { ThemeProvider, useThemeFileEditing } from "@/modules/theme";
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
import { invoke } from "@tauri-apps/api/core";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Layout, LayoutChangedMeta } from "react-resizable-panels";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { CloseDialogs } from "./components/CloseDialogs";
import { WorkspaceConnectionPlaceholder } from "./components/WorkspaceConnectionPlaceholder";
import { spaceDeleteDocuments } from "./lib/spaceDelete";
import { WorkspaceInputBar } from "./components/WorkspaceInputBar";
import { useAppCloseGuard } from "./hooks/useAppCloseGuard";
import { useTabCloseGuards } from "./hooks/useTabCloseGuards";
import { useWorkspaceEnvironment } from "./hooks/useWorkspaceEnvironment";
import { useZenMode } from "./hooks/useZenMode";

type WorkspaceActivation = {
  requestId: string;
  environment: string;
  workspaceId: string;
};

function parseWorkspaceActivation(value: unknown): WorkspaceActivation | null {
  if (!value || typeof value !== "object") return null;
  const { requestId, environment, workspaceId } = value as Record<
    string,
    unknown
  >;
  if (
    typeof requestId !== "string" ||
    typeof environment !== "string" ||
    typeof workspaceId !== "string"
  ) {
    return null;
  }
  return { requestId, environment, workspaceId };
}

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
 * 负责组合工作区、终端和侧栏。空 Space 不启动终端，目录入口只把当前环境内用户明确选择的路径传给新终端。
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
    newAgentTab,
    newRunTab,
    newPrivateTab,
    openFileTab,
    pinTab,
    newWebPreviewTab,
    newMarkdownTab,
    setOverrideLanguage,
    openAiDiffTab,
    setAiDiffStatus,
    openGitDiffTab,
    openCommitHistoryTab,
    openCommitFileDiffTab,
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

  const activeTerminalTab = useMemo(() => {
    const t = tabs.find((x) => x.id === activeId);
    return t && t.kind === "terminal" ? t : null;
  }, [tabs, activeId]);
  const activeTerminalId = activeTerminalTab?.id ?? null;

  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(new Map());
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(new Map());
  const markdownNavigationRefs = useRef(
    new Map<number, MarkdownPreviewPaneHandle>(),
  );
  const pendingGotoLine = useRef<Map<number, number>>(new Map());
  const webPreviewRefs = useRef<Map<number, WebPreviewPaneHandle>>(new Map());
  const explorerReturnFocusRef = useRef<HTMLElement | null>(null);
  const [activeEditorHandle, setActiveEditorHandle] =
    useState<EditorPaneHandle | null>(null);
  const gitHistoryRefs = useRef(new Map<number, FindHandle>());
  const { zoomIn, zoomOut, zoomReset } = useZoom();
  useTerminalFileDrop();
  const explorerRef = useRef<FileExplorerHandle>(null);
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
  const { enabled: zenMode, toggle: toggleZenMode } = useZenMode({
    onFullscreenError: handleZenFullscreenError,
    focusWorkbench: focusActiveWorkbench,
  });

  // Session disposal follows stable terminal ids, not React lifecycles.
  const liveTerminalIdsRef = useRef<Set<number>>(new Set());

  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const workspaceWindowMode = usePreferencesStore((s) => s.workspaceWindowMode);
  const activationRequestRef = useRef<string | null>(null);
  const {
    home,
    launchCwd,
    launchCwdResolved,
    environmentError,
    remoteEventsReady,
    hostPrompt,
    clearHostPrompt,
    ensureWorkspaceReady,
    reconnectWorkspace,
  } = useWorkspaceEnvironment();
  const [sshConnectionOpen, setSshConnectionOpen] = useState(false);
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
  const spacesHydrated = useSpaces((s) => s.hydrated);

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

  const sidebar = useSidebarLayout(undefined, zenMode);
  const toggleSidebar = useCallback(() => {
    sidebar.toggleLocation("primary");
  }, [sidebar.toggleLocation]);
  const commitWorkbenchLayout = useCallback(
    (_layout: Layout, meta: LayoutChangedMeta) => {
      if (!meta.isUserInteraction) return;
      sidebar.commitLayout();
    },
    [sidebar.commitLayout],
  );
  const [newEditorOpen, setNewEditorOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [paletteInitialMode, setPaletteInitialMode] = useState<
    "commands" | "content"
  >("commands");
  const openCommandPalette = useCallback(
    (mode: "commands" | "content" = "commands") => {
      setPaletteInitialMode(mode);
      setCommandPaletteOpen(true);
    },
    [],
  );
  const focusInput = useChatStore((s) => s.focusInput);
  const setLive = useChatStore((s) => s.setLive);
  const respondApproval = useApprovalStore((state) => state.respond);

  const { hasComposer } = useAiBootstrap();

  const activeTab = tabs.find((t) => t.id === activeId);
  const isTerminalTab = activeTab?.kind === "terminal";
  const isBlockTab = activeTerminalTab?.blocks === true;
  const isEditorTab =
    activeTab?.kind === "editor" ||
    (activeTab?.kind === "markdown" && activeEditorHandle !== null);
  const isGitHistoryTab = activeTab?.kind === "git-history";

  useEditorFileSync({ tabs, tabsRef, editorRefs });
  useThemeFileEditing({ tabsRef, openFileTab });

  const { explorerRoot: resolvedExplorerRoot, inheritedCwdForNewTab } =
    useWorkspaceCwd(activeTab, tabs, home);
  const explorerRoot = spaceTabs.length === 0 ? null : resolvedExplorerRoot;
  const pythonRunner = usePythonFileRunner({
    workspace: workspaceEnv,
    explorerRoot,
    tabsRef,
    editorRefs,
    ensureWorkspaceReady,
    newRunTab,
  });
  const [explorerStartupReady, setExplorerStartupReady] = useState(
    () => currentWorkspaceEnv().kind === "local",
  );

  useEffect(() => {
    if (explorerStartupReady || !spacesHydrated) return;
    if (workspaceEnv.kind === "local" || activeTab?.kind !== "terminal") {
      setExplorerStartupReady(true);
      return;
    }

    let active = true;
    // 只在首次远端启动且前台页为终端时排序，后续切换标签不重复阻塞 Explorer。
    void whenSessionReady(activeTab.id).then(() => {
      if (active) setExplorerStartupReady(true);
    });
    return () => {
      active = false;
    };
  }, [activeTab, explorerStartupReady, spacesHydrated, workspaceEnv.kind]);

  useStartupWarmup({
    enabled: workbenchBooted && spacesHydrated && explorerStartupReady,
    state: workbenchState,
    activeSpaceId: activeSpaceId ?? DEFAULT_SPACE_ID,
    activeTab,
    warmTabInBackground,
  });

  useExplorerDirectoryPrefetch({
    enabled: workbenchBooted && spacesHydrated && explorerStartupReady,
    tabs,
    currentRoot: explorerRoot,
  });

  useWindowTitle(activeTab, explorerRoot);

  useEffect(() => {
    setActiveEditorHandle(editorRefs.current.get(activeId) ?? null);
  }, [activeId]);

  const disposeTab = useCallback(
    (id: number) => {
      const closing = tabsRef.current.find((tab) => tab.id === id);
      const next = closeTab(id);
      if (next.tabs[id]) return;
      if (closing && isDocumentTab(closing)) {
        if (!hasOtherDocumentView(Object.values(next.tabs), closing)) {
          const workspace = currentWorkspaceEnv();
          void import("@/modules/editor/lib/documentModel").then(
            ({ discardSharedDocumentModel }) =>
              discardSharedDocumentModel(workspace, closing.path),
          );
        }
      }
      // Terminal-id maps are pruned by the effect below; tab-id handles need
      // explicit cleanup here.
      editorRefs.current.delete(id);
      markdownNavigationRefs.current.delete(id);
      pendingGotoLine.current.delete(id);
      webPreviewRefs.current.delete(id);
      gitHistoryRefs.current.delete(id);
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
    if (!selection || !selection.trim()) {
      openAiPanelAndFocus();
      return;
    }
    const source: "terminal" | "editor" = isEditorTab ? "editor" : "terminal";
    if (!openAiPanel()) return;
    attachSelection(selection, source);
  }, [
    captureActiveSelection,
    openAiPanel,
    openAiPanelAndFocus,
    attachSelection,
    isEditorTab,
  ]);

  const { askPopup, setAskPopup, onAskFromSelection } = useSelectionAskAi({
    captureActiveSelection,
    askFromSelection,
  });
  const askPresence = usePresence(Boolean(askPopup), 120);

  const activeFindHandle = useCallback((): FindHandle | null => {
    const tabId = activeIdRef.current;
    const editor = editorRefs.current.get(tabId);
    if (editor) return editor;
    const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
    if (tab?.kind === "terminal") {
      return terminalRefs.current.get(tab.id) ?? null;
    }
    if (tab?.kind === "git-history") {
      return gitHistoryRefs.current.get(tabId) ?? null;
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
      if (!readyHome) return;
      const targetCwd = cwd ?? readyHome;
      if (kind === "block") newBlockTab(targetCwd, groupId);
      else if (kind === "private") newPrivateTab(targetCwd, groupId);
      else newTab(targetCwd, groupId);
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

  /**
   * 通过原生目录选择器在当前 Local 工作区打开一个终端标签页。
   *
   * 选择器返回宿主机路径，因此 WSL 和 SSH 进程不得调用。路径统一为正斜杠，保持前端工作区路径约定。
   */
  const openFolder = useCallback(async () => {
    if (workspaceEnv.kind !== "local") return;

    try {
      const selected = await openFolderDialog({
        directory: true,
        multiple: false,
        title: t("openFolder"),
      });
      if (typeof selected === "string") {
        newTab(selected.replace(/\\/g, "/"));
      }
    } catch {
      toast.error(t("openFolderFailed"));
    }
  }, [newTab, t, workspaceEnv.kind]);

  const openEnvironmentHome = useCallback(async () => {
    const readyHome = await ensureWorkspaceReady();
    if (readyHome) newTab(readyHome);
  }, [ensureWorkspaceReady, newTab]);

  /**
   * 校验当前 WSL 或 SSH 环境中的目录并在该目录创建普通终端。
   *
   * 路径只在用户显式提交时访问，空 Workbench 本身不会触发远端文件请求。
   */
  const openEnvironmentPath = useCallback(
    async (path: string) => {
      if (workspaceEnv.kind === "local") return;
      try {
        if (!(await ensureWorkspaceReady())) return;
        const canonical = await native.canonicalize(path);
        const stat = await invoke<{ kind: string }>("fs_stat", {
          path: canonical,
          workspace: workspaceEnv,
        });
        if (stat.kind !== "dir") throw new Error(t("folderPathInvalid"));
        newTab(canonical);
      } catch {
        toast.error(t("folderPathInvalid"));
      }
    },
    [ensureWorkspaceReady, newTab, t, workspaceEnv],
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
      // Markdown opens in its rendered view by default; a per-tab toggle flips
      // it to the raw editor. Other files default to preview (pin=false);
      // explicit actions like context-menu "Open" pass pin=true to persist.
      if (isMarkdownPath(path)) newMarkdownTab(path, explorerRoot ?? undefined);
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
        ? newMarkdownTab(path, explorerRoot ?? undefined, groupId, forceNew)
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
    void consumeLaunchFiles().then((files) =>
      openLaunchFilesRef.current(files),
    );
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onSharedStoreChange("settings", async () => {
      const activation = parseWorkspaceActivation(
        (await readSharedStore("settings")).workspaceActivation,
      );
      if (
        !activation ||
        activation.environment !== currentWorkspaceBootstrap().environmentKey ||
        activation.workspaceId !== currentWorkspaceBootstrap().id ||
        activation.requestId === activationRequestRef.current
      ) {
        return;
      }
      activationRequestRef.current = activation.requestId;
      const window = getCurrentWindow();
      await window.show();
      await window.setFocus();
      const files = await consumeWorkspaceOpenFiles();
      if (!disposed) await openLaunchFilesRef.current(files);
    })
      .then((next) => {
        if (disposed) next();
        else unlisten = next;
      })
      .catch((error) =>
        console.error("workspace activation listener failed:", error),
      );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

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
  const { sourceControl, openGitGraphFromContext } = useSourceControlContext({
    activeTab,
    tabs,
    activeTerminalCwd,
    explorerRoot,
    launchCwd,
    launchCwdResolved: spaceTabs.length > 0 && launchCwdResolved,
    home,
    sourceControlVisible: sidebar.isVisible("source-control"),
    openCommitHistoryTab,
    closeTab,
  });
  const explorerGitDecorations = usePreferencesStore(
    (s) => s.explorerGitDecorations,
  );

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
      "commandPalette.open": () => openCommandPalette("commands"),
      "commandPalette.content": () => openCommandPalette("content"),
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
        const line = pendingGotoLine.current.get(id);
        if (line != null) {
          pendingGotoLine.current.delete(id);
          h.gotoLine(line);
        }
      } else {
        editorRefs.current.delete(id);
      }
      if (id === activeIdRef.current) setActiveEditorHandle(h);
    },
    [],
  );

  const registerMarkdownNavigationHandle = useCallback(
    (id: number, handle: MarkdownPreviewPaneHandle | null) => {
      if (handle) {
        markdownNavigationRefs.current.set(id, handle);
        const line = pendingGotoLine.current.get(id);
        if (line != null) {
          pendingGotoLine.current.delete(id);
          handle.gotoSourceLine(line);
        }
      } else {
        markdownNavigationRefs.current.delete(id);
      }
    },
    [],
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

  const handleNewSpace = useCallback(() => {
    const { spaces, create, setActive } = useSpaces.getState();
    const meta = create({
      name: `Space ${spaces.length + 1}`,
      root: null,
    });
    createSpace(meta.id);
    setActive(meta.id);
    return meta.id;
  }, [createSpace]);

  const deleteSpace = useCallback(
    (id: string) => {
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
      const root = useSpaces
        .getState()
        .spaces.find((s) => s.id === spaceId)?.root;
      newTabInSpace(spaceId, root ?? readyHome);
    },
    [ensureWorkspaceReady, newTabInSpace],
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
            canFind: isTerminalTab || isEditorTab || isGitHistoryTab,
            explorerRoot,
            home,
            openNewWindow,
            workspaceWindowMode,
            openNewTab,
            openNewBlock: openNewBlockTab,
            openNewPrivate: openNewPrivateTab,
            openNewEditor: () => void openNewEditor(),
            openNewWebPreview: () => openWebPreviewTab(""),
            openGitGraph: openGitGraphFromContext,
            toggleSourceControl,
            closeActiveTab: handleCloseActiveTab,
            splitGroupRight: () => splitActiveTab("right"),
            splitGroupDown: () => splitActiveTab("down"),
            focusSearch: focusFind,
            focusExplorerSearch: () => explorerRef.current?.focusSearch(),
            toggleSidebar,
            setActivityBarPosition: sidebar.setActivityBarPosition,
            setActivityBarSize: sidebar.setActivityBarSize,
            toggleAi: toggleAiPanel,
            askAiSelection: askFromSelection,
            openSettings: () => void openSettingsWindow(),
            openKeyboardShortcuts: () => void openSettingsWindow("shortcuts"),
            spaces: useSpaces.getState().spaces,
            activeSpaceId,
            openSpacesOverview: () => setSwitcherOpen(true),
            newSpace: () => void handleNewSpace(),
            switchSpace: (id) => useSpaces.getState().setActive(id),
          })
        : [],
    [
      commandPaletteOpen,
      tabs,
      activeId,
      isTerminalTab,
      isEditorTab,
      isGitHistoryTab,
      explorerRoot,
      home,
      openNewWindow,
      workspaceWindowMode,
      openNewTab,
      openNewBlockTab,
      openNewEditor,
      openNewPrivateTab,
      openWebPreviewTab,
      openGitGraphFromContext,
      toggleSourceControl,
      handleCloseActiveTab,
      splitActiveTab,
      focusFind,
      toggleSidebar,
      sidebar.setActivityBarPosition,
      sidebar.setActivityBarSize,
      toggleAiPanel,
      askFromSelection,
      activeSpaceId,
      handleNewSpace,
    ],
  );

  const openContentHit = useCallback(
    (path: string, line: number) => {
      const markdown = isMarkdownPath(path);
      const id = markdown ? newMarkdownTab(path) : openFileTab(path, true);
      if (id == null) return;
      const editor = editorRefs.current.get(id);
      const markdownNavigation = markdownNavigationRefs.current.get(id);
      if (markdownNavigation) markdownNavigation.gotoSourceLine(line);
      else if (editor) editor.gotoLine(line);
      else pendingGotoLine.current.set(id, line);
    },
    [newMarkdownTab, openFileTab],
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
    setLive,
    activeId,
    activeSpaceId,
    tabs,
    explorerRoot,
    setActiveId,
    newTab,
    openWebPreviewTab,
    newAgentTab,
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
      newGitGraph: (groupId) => {
        setActiveGroup(groupId);
        openGitGraphFromContext();
      },
      closeTab: (tabId) => void handleClose(tabId),
      runPythonFile: pythonRunner.runTab,
      attachFileToAgent: handleAttachFileToAgent,
      pinTab,
      renameTab: handleRenameTab,
      dropTab: handleDropTab,
      splitTab: (tabId, direction, move) =>
        void splitTab(tabId, direction, move),
      overrideLanguage: setOverrideLanguage,
      resizeSplit,
    }),
    [
      handleClose,
      handleDropTab,
      handleAttachFileToAgent,
      handleRenameTab,
      groupCwd,
      openNewEditor,
      openTerminalPage,
      openGitGraphFromContext,
      openWebPreviewTab,
      pinTab,
      resizeSplit,
      pythonRunner.runTab,
      setActiveGroup,
      setActiveId,
      setOverrideLanguage,
      splitTab,
    ],
  );

  const registerGitHistoryHandle = useCallback(
    (tabId: number, handle: FindHandle | null) => {
      if (handle) gitHistoryRefs.current.set(tabId, handle);
      else gitHistoryRefs.current.delete(tabId);
    },
    [],
  );

  const workbenchServices = useMemo<WorkbenchViewServices>(
    () => ({
      registerTerminalHandle,
      onTerminalCwd: handleTerminalCwd,
      onTerminalExit: handleTerminalExit,
      onFocusTab: setActiveId,
      registerEditorHandle,
      registerMarkdownNavigationHandle,
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
      onOpenCommitFile: openCommitFileDiffTab,
      onGitHistoryFindHandle: registerGitHistoryHandle,
    }),
    [
      handleEditorDirty,
      handleWebPreviewUrl,
      handleTerminalCwd,
      handleTerminalExit,
      openCommitFileDiffTab,
      registerEditorHandle,
      registerGitHistoryHandle,
      registerMarkdownNavigationHandle,
      registerWebPreviewHandle,
      registerTerminalHandle,
      requestEditorClose,
      respondApproval,
      setAiDiffStatus,
      setActiveId,
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
          rootPath={explorerStartupReady ? explorerRoot : null}
          rootPending={
            workspaceBootPending
              ? workspaceEnv.kind === "ssh"
                ? "connection"
                : "loading"
              : spaceTabs.length > 0 &&
                  !explorerStartupReady &&
                  !environmentError
                ? "loading"
                : undefined
          }
          onOpenFolder={workspaceEnv.kind === "local" ? openFolder : undefined}
          onOpenHome={
            workspaceEnv.kind === "local" ? undefined : openEnvironmentHome
          }
          onOpenPath={
            workspaceEnv.kind === "local" ? undefined : openEnvironmentPath
          }
          onReconnect={requestSshReconnect}
          gitStatus={explorerGitDecorations ? sourceControl.status : null}
          activeFilePath={explorerActiveFilePath}
          onOpenFile={handleOpenFile}
          onPathRenamed={handlePathRenamed}
          onPathDeleted={handlePathDeleted}
          onRevealInTerminal={cdInNewTab}
          onRunPythonFile={(path, root) =>
            void pythonRunner.runFile(path, root)
          }
          onAttachToAgent={handleAttachFileToAgent}
          onDropToWorkbench={handleDropFileToWorkbench}
        />
      ),
    },
    {
      id: "source-control",
      content: (
        <SourceControlViewContainer
          open={sidebar.isVisible("source-control")}
          sourceControl={sourceControl}
          onOpenDiff={openGitDiffTab}
          onOpenGitGraph={openGitGraphFromContext}
          fullGraphOpen={activeTab?.kind === "git-history"}
          onOpenCommitFile={openCommitFileDiffTab}
          onOpenFile={handleOpenFile}
          onNavigateToPath={cdInNewTab}
        />
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
        <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
          {!zenMode && (
            <Header
              onToggleSidebar={toggleSidebar}
              onOpenCommandPalette={() => openCommandPalette("commands")}
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
                activeId={sidebar.runtime.primary.activeId}
                badges={sidebarBadges}
                onActivate={sidebar.toggleContainer}
                onMove={sidebar.moveContainer}
                onReset={sidebar.resetContainerLocation}
              />
            ) : null}
            <ResizablePanelGroup
              orientation="horizontal"
              className="min-h-0 min-w-0 flex-1"
              onLayoutChanged={commitWorkbenchLayout}
            >
              <ResizablePanel
                id="primary-sidebar"
                panelRef={sidebar.panelRefs.primary}
                groupResizeBehavior="preserve-pixel-size"
                defaultSize={
                  sidebar.initialRuntime.primary.collapsed
                    ? "0px"
                    : `${sidebar.initialRuntime.primary.width}px`
                }
                minSize={`${sidebar.minimumWidth("primary")}px`}
                collapsible
                collapsedSize={0}
              >
                <div
                  data-sidebar-drop-zone="primary"
                  inert={zenMode}
                  aria-hidden={zenMode || undefined}
                  className={cn(
                    "sidebar-scrollbar-scope relative flex h-full min-h-0 flex-col border-r border-border/60 bg-sidebar transition-[opacity,translate] duration-pane ease-standard",
                    sidebar.runtime.primary.collapsed
                      ? "pointer-events-none -translate-x-1.5 opacity-0"
                      : "translate-x-0 opacity-100",
                  )}
                >
                  {sidebar.activityBar.position === "top" ? (
                    <SidebarActivityBar
                      {...sidebarConfigurationProps}
                      containers={primarySidebarContainers}
                      activeId={sidebar.runtime.primary.activeId}
                      badges={sidebarBadges}
                      onActivate={sidebar.openContainer}
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
                      activeId={sidebar.runtime.primary.activeId}
                      badges={sidebarBadges}
                      onActivate={sidebar.openContainer}
                      onMove={sidebar.moveContainer}
                      onReset={sidebar.resetContainerLocation}
                    />
                  ) : null}
                </div>
              </ResizablePanel>
              <ResizableHandle
                withHandle
                className={cn(zenMode && "hidden")}
                disabled={zenMode || sidebar.runtime.primary.collapsed}
              />
              <ResizablePanel
                id="workspace"
                defaultSize="78%"
                minSize={`${WORKSPACE_MIN_WIDTH}px`}
              >
                <div className="flex h-full min-h-0 flex-col">
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
                className={cn(zenMode && "hidden")}
                disabled={zenMode || sidebar.runtime.secondary.collapsed}
              />
              <ResizablePanel
                id="secondary-sidebar"
                panelRef={sidebar.panelRefs.secondary}
                groupResizeBehavior="preserve-pixel-size"
                defaultSize={
                  sidebar.initialRuntime.secondary.collapsed
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

          {hasComposer ? (
            <>
              <AgentRunBridge />
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
            initialMode={paletteInitialMode}
            commandItems={commandPaletteItems}
            workspaceRoot={explorerRoot}
            onOpenContentHit={openContentHit}
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
    <AiComposerProvider>
      <RepositoryProvider controller={sourceControl}>
        {shell}
      </RepositoryProvider>
    </AiComposerProvider>
  );
}

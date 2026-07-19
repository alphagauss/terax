import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  consumeLaunchFiles,
  consumeWorkspaceOpenFiles,
  getLaunchDir,
} from "@/lib/launchDir";
import { onSharedStoreChange, readSharedStore } from "@/lib/sharedStore";
import { quoteShellArg } from "@/lib/shellQuote";
import { usePresence } from "@/lib/usePresence";
import { useZoom } from "@/lib/useZoom";
import { cn, isMarkdownPath } from "@/lib/utils";
import {
  AgentNotificationsBridge,
  nextAttentionTarget,
} from "@/modules/agents";
import {
  AgentRunBridge,
  AiSidebarPanel,
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
import { CommandPalette, createCommandItems } from "@/modules/command-palette";
import {
  type EditorPaneHandle,
  hasOtherDocumentView,
  isDocumentTab,
  NewEditorDialog,
  useApplyEditorFontSize,
  useEditorFileSync,
} from "@/modules/editor";
import { FileExplorer, type FileExplorerHandle } from "@/modules/explorer";
import type { FindHandle } from "@/modules/find";
import { Header } from "@/modules/header";
import { setLspNavigator } from "@/modules/lsp";
import type { MarkdownPreviewPaneHandle } from "@/modules/markdown/MarkdownPreviewPane";
import type { WebPreviewPaneHandle } from "@/modules/preview";
import { HostKeyDialog } from "@/modules/remote";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type ShortcutHandlers,
  type ShortcutId,
  useGlobalShortcuts,
} from "@/modules/shortcuts";
import {
  SECONDARY_SIDEBAR_MAX_WIDTH,
  SECONDARY_SIDEBAR_MIN_WIDTH,
  SecondarySidebar,
  type SecondarySidebarView,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SidebarRail,
  useSecondarySidebarPanel,
  useSidebarPanel,
  WORKSPACE_MIN_WIDTH,
} from "@/modules/sidebar";
import {
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
  leafHasForegroundProcess,
  navigateFocusedBlocks,
  type TerminalPaneHandle,
  useTerminalFileDrop,
  writeToSession,
} from "@/modules/terminal";
import { ThemeProvider, useThemeFileEditing } from "@/modules/theme";
import {
  DEFAULT_SPACE_ID,
  findGroupForTab,
  useWorkbench,
  type WorkbenchChromeActions,
  type TerminalTab,
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
  policyForEnvironmentSelection,
  spawnWorkspaceProcess,
} from "@/modules/workspace-process";
import { AiChat01Icon } from "@hugeicons/core-free-icons";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Layout, LayoutChangedMeta } from "react-resizable-panels";
import { toast } from "sonner";
import { CloseDialogs } from "./components/CloseDialogs";
import { spaceDeleteDocuments } from "./lib/spaceDelete";
import { WorkspaceInputBar } from "./components/WorkspaceInputBar";
import { useAppCloseGuard } from "./hooks/useAppCloseGuard";
import { useTabCloseGuards } from "./hooks/useTabCloseGuards";
import { useWorkspaceEnvironment } from "./hooks/useWorkspaceEnvironment";

type WorkspaceActivation = {
  requestId: string;
  environment: string;
  workspaceId: string;
};

const SECONDARY_SIDEBAR_VIEW_IDS = ["ai"] as const;

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

export default function App() {
  const initialLaunchCwd =
    currentWorkspaceEnv().kind === "local" ? getLaunchDir() : null;
  const revealWorkbenchSpace = useCallback((spaceId: string) => {
    useSpaces.getState().setActive(spaceId);
  }, []);
  const {
    state: workbenchState,
    tabs,
    activeId,
    setActiveId,
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
    markBooted,
    setActiveSpace,
    newTab,
    newBlockTab,
    newAgentTab,
    newPrivateTab,
    openFileTab,
    pinTab,
    newWebPreviewTab,
    newMarkdownTab,
    setOverrideLanguage,
    openAiDiffTab,
    closeAiDiffTab,
    openGitDiffTab,
    openCommitHistoryTab,
    openCommitFileDiffTab,
    closeTab,
    updateTab,
    setDocumentDirty,
    selectByIndex,
    setTerminalCwd,
    focusGroup,
    splitTab,
    resizeSplit,
  } = useWorkbench(
    initialLaunchCwd ? { cwd: initialLaunchCwd } : undefined,
    revealWorkbenchSpace,
  );

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
  const activeTerminalId = activeTerminalTab?.terminalId ?? null;

  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(new Map());
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(new Map());
  const markdownNavigationRefs = useRef(
    new Map<number, MarkdownPreviewPaneHandle>(),
  );
  const pendingGotoLine = useRef<Map<number, number>>(new Map());
  const webPreviewRefs = useRef<Map<number, WebPreviewPaneHandle>>(new Map());
  const [activeEditorHandle, setActiveEditorHandle] =
    useState<EditorPaneHandle | null>(null);
  const gitHistoryRefs = useRef(new Map<number, FindHandle>());
  const { zoomIn, zoomOut, zoomReset } = useZoom();
  useApplyEditorFontSize();
  useTerminalFileDrop();
  const explorerRef = useRef<FileExplorerHandle>(null);

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
    initializeWorkspaceEnv,
  } = useWorkspaceEnvironment();

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
    initializeWorkspaceEnv,
    environmentHome: home,
  });

  useSpacePersistence({
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

  const {
    sidebarRef,
    sidebarWidthRef,
    sidebarView,
    sidebarCollapsed,
    initialSidebarCollapsed,
    persistSidebarView,
    toggleSidebar,
    cycleSidebarView,
    commitSidebarLayout,
    toggleExplorerFocus,
  } = useSidebarPanel(explorerRef);

  const secondarySidebar = useSecondarySidebarPanel(SECONDARY_SIDEBAR_VIEW_IDS);
  const commitWorkbenchLayout = useCallback(
    (_layout: Layout, meta: LayoutChangedMeta) => {
      if (!meta.isUserInteraction) return;
      commitSidebarLayout();
      secondarySidebar.commitLayout();
    },
    [commitSidebarLayout, secondarySidebar.commitLayout],
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
  const respondToApproval = useChatStore((s) => s.respondToApproval);

  const { hasComposer } = useAiBootstrap();

  const secondarySidebarViews = useMemo<readonly SecondarySidebarView[]>(
    () => [
      {
        id: "ai",
        label: "AI",
        icon: AiChat01Icon,
        content: (
          <AiSidebarPanel
            hasComposer={hasComposer}
            onClose={secondarySidebar.close}
          />
        ),
      },
    ],
    [hasComposer, secondarySidebar.close],
  );

  const activeTab = tabs.find((t) => t.id === activeId);
  const isTerminalTab = activeTab?.kind === "terminal";
  const isBlockTab = activeTerminalTab?.blocks === true;
  const isEditorTab =
    activeTab?.kind === "editor" ||
    (activeTab?.kind === "markdown" && activeEditorHandle !== null);
  const isGitHistoryTab = activeTab?.kind === "git-history";

  useEditorFileSync({ tabs, tabsRef, editorRefs });
  useThemeFileEditing({ tabsRef, openFileTab });

  const { explorerRoot, inheritedCwdForNewTab } = useWorkspaceCwd(
    activeTab,
    tabs,
    home,
  );

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

  const { pendingAppClose, confirmAppClose, cancelAppClose } = useAppCloseGuard(
    tabsRef,
    flushCompletedSessionRuns,
  );
  const [pendingSpaceDelete, setPendingSpaceDelete] = useState<{
    spaceId: string;
    dirtyDocuments: number;
    busyTerminal: boolean;
  } | null>(null);

  useEffect(() => {
    const live = new Set<number>();
    for (const t of tabs) {
      if (t.kind === "terminal") live.add(t.terminalId);
    }
    for (const id of liveTerminalIdsRef.current) {
      if (!live.has(id)) disposeSession(id);
    }
    liveTerminalIdsRef.current = live;
    for (const k of [...terminalRefs.current.keys()])
      if (!live.has(k)) terminalRefs.current.delete(k);
  }, [tabs]);

  // Most-recently-used tab ids, most recent first, pruned to live tabs. Drives
  // the Ctrl+Tab quick switcher so it cycles by recency, not strip order.
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

  const getSwitcherOrder = useCallback(() => {
    const space = activeSpaceId ?? DEFAULT_SPACE_ID;
    const inSpace = tabsRef.current
      .filter((t) => t.spaceId === space)
      .map((t) => t.id);
    const present = new Set(inSpace);
    const ordered = mruRef.current.filter((id) => present.has(id));
    for (const id of inSpace) if (!ordered.includes(id)) ordered.push(id);
    return [activeId, ...ordered.filter((id) => id !== activeId)];
  }, [activeId, activeSpaceId]);

  const { state: switcherState, step: stepSwitcher } = useTabSwitcher({
    getOrder: getSwitcherOrder,
    onCommit: (id) => {
      if (tabsRef.current.some((t) => t.id === id)) setActiveId(id);
    },
  });

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
      return terminalRefs.current.get(t.terminalId)?.getSelection() ?? null;
    }
    if (t.kind === "editor" || t.kind === "markdown") {
      return editorRefs.current.get(activeId)?.getSelection() ?? null;
    }
    return null;
  }, [tabs, activeId]);

  const openAiPanel = useCallback(() => {
    secondarySidebar.persistView("ai");
    secondarySidebar.open();
  }, [secondarySidebar.open, secondarySidebar.persistView]);

  const openAiPanelAndFocus = useCallback(
    (prefill: string | null = null) => {
      openAiPanel();
      focusInput(prefill);
    },
    [focusInput, openAiPanel],
  );

  const toggleAiPanel = useCallback(() => {
    if (secondarySidebar.collapsed) {
      openAiPanelAndFocus();
    } else {
      secondarySidebar.close();
    }
  }, [openAiPanelAndFocus, secondarySidebar.close, secondarySidebar.collapsed]);

  const attachSelection = useChatStore((s) => s.attachSelection);
  const attachFile = useChatStore((s) => s.attachFile);

  const handleAttachFileToAgent = useCallback(
    (path: string) => {
      attachFile(path);
      openAiPanelAndFocus();
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
    openAiPanel();
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
      return terminalRefs.current.get(tab.terminalId) ?? null;
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

  const openNewTab = useCallback(() => {
    newTab(inheritedCwdForNewTab());
  }, [newTab, inheritedCwdForNewTab]);

  const openNewPrivateTab = useCallback(() => {
    newPrivateTab(inheritedCwdForNewTab());
  }, [newPrivateTab, inheritedCwdForNewTab]);

  const openNewBlockTab = useCallback(() => {
    newBlockTab(inheritedCwdForNewTab());
  }, [newBlockTab, inheritedCwdForNewTab]);

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
        const t = terminalRefs.current.get(tab.terminalId);
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
  const { sourceControl, toggleSourceControl, openGitGraphFromContext } =
    useSourceControlContext({
      activeTab,
      tabs,
      activeTerminalCwd,
      explorerRoot,
      launchCwd,
      launchCwdResolved,
      home,
      sidebarView,
      cycleSidebarView,
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

  const [zenMode, setZenMode] = useState(false);

  // Focus an agent's tab, switching to its Space before activating its group.
  const activateAgentTarget = useCallback(
    (tabId: number, _terminalId: number) => {
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
      "tab.newEditor": () => setNewEditorOpen(true),
      "tab.close": handleCloseActiveTab,
      "tab.next": () => stepSwitcher(1),
      "tab.prev": () => stepSwitcher(-1),
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
        const t = nextAttentionTarget();
        if (t) activateAgentTarget(t.tabId, t.leafId);
      },
      "settings.open": () => void openSettingsWindow(),
      "sidebar.toggle": toggleSidebar,
      "explorer.focus": toggleExplorerFocus,
      "view.zoomIn": zoomIn,
      "view.zoomOut": zoomOut,
      "view.zoomReset": zoomReset,
      "view.zenMode": () => setZenMode((v) => !v),
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
      cycleSpace,
      handleCloseActiveTab,
      openNewTab,
      openNewBlockTab,
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
      toggleSidebar,
      toggleExplorerFocus,
      zoomIn,
      zoomOut,
      zoomReset,
      activateAgentTarget,
    ],
  );

  const shortcutsDisabled = useCallback(
    (id: ShortcutId, e: KeyboardEvent) => {
      if (id === "search.focus") {
        return activeFindHandle() === null;
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
    [activeFindHandle, activeTab, captureActiveSelection, isEditorTab],
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
    (terminalId: number, cwd: string) => {
      setTerminalCwd(terminalId, cwd);
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

  const onActivateLocalAgent = useCallback(() => {
    openAiPanelAndFocus();
  }, [openAiPanelAndFocus]);

  const handleTerminalExit = useCallback(
    (terminalId: number, _code: number) => {
      const all = tabsRef.current;
      const tab = all.find(
        (candidate) =>
          candidate.kind === "terminal" && candidate.terminalId === terminalId,
      );
      if (!tab || tab.kind !== "terminal") return;
      if (all.length === 1) {
        void getCurrentWindow().close();
      } else {
        closeExitedTerminal(tab.id);
      }
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
      root: activeCwd ?? home ?? null,
    });
    createSpace(meta.id, activeCwd ?? undefined);
    setActive(meta.id);
    return meta.id;
  }, [activeCwd, createSpace, home]);

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
      const root = useSpaces
        .getState()
        .spaces.find((s) => s.id === nextSpaceId)?.root;
      removeSpace(id, nextSpaceId, root ?? undefined);
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
            leafHasForegroundProcess(tab.terminalId).catch(() => true),
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
    (spaceId: string) => {
      const root = useSpaces
        .getState()
        .spaces.find((s) => s.id === spaceId)?.root;
      newTabInSpace(spaceId, root ?? undefined);
    },
    [newTabInSpace],
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
            openNewEditor: () => setNewEditorOpen(true),
            openNewWebPreview: () => openWebPreviewTab(""),
            openGitGraph: openGitGraphFromContext,
            toggleSourceControl,
            closeActiveTab: handleCloseActiveTab,
            splitGroupRight: () => splitActiveTab("right"),
            splitGroupDown: () => splitActiveTab("down"),
            focusSearch: focusFind,
            focusExplorerSearch: () => explorerRef.current?.focusSearch(),
            toggleSidebar,
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
      openNewPrivateTab,
      openWebPreviewTab,
      openGitGraphFromContext,
      toggleSourceControl,
      handleCloseActiveTab,
      splitActiveTab,
      focusFind,
      toggleSidebar,
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
    tabs,
    explorerRoot,
    launchCwd,
    home,
    openWebPreviewTab,
    newAgentTab,
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
      const tab = space
        ? workbenchState.tabs[space.groups[groupId]?.activeTabId]
        : undefined;
      return tab?.kind === "terminal" ? tab.cwd : inheritedCwdForNewTab();
    },
    [activeSpaceId, inheritedCwdForNewTab, workbenchState],
  );

  const workbenchActions = useMemo<WorkbenchChromeActions>(
    () => ({
      selectTab: setActiveId,
      activateGroup: setActiveGroup,
      newTerminal: (groupId) => newTab(groupCwd(groupId), groupId),
      newBlock: (groupId) => newBlockTab(groupCwd(groupId), groupId),
      newPrivate: (groupId) => newPrivateTab(groupCwd(groupId), groupId),
      newWebPreview: (groupId) => openWebPreviewTab("", groupId),
      newEditor: (groupId) => {
        setActiveGroup(groupId);
        setNewEditorOpen(true);
      },
      newGitGraph: (groupId) => {
        setActiveGroup(groupId);
        openGitGraphFromContext();
      },
      closeTab: (tabId) => void handleClose(tabId),
      pinTab,
      renameTab: handleRenameTab,
      dropTab: handleDropTab,
      splitTab: (tabId, direction, move) =>
        void splitTab(tabId, direction, move),
      overrideLanguage: setOverrideLanguage,
      resizeSplit,
    }),
    [
      groupCwd,
      handleClose,
      handleDropTab,
      handleRenameTab,
      newBlockTab,
      newPrivateTab,
      newTab,
      openGitGraphFromContext,
      openWebPreviewTab,
      pinTab,
      resizeSplit,
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
      onAiDiffAccept: (id) => respondToApproval(id, true),
      onAiDiffReject: (id) => respondToApproval(id, false),
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
      respondToApproval,
      setActiveId,
    ],
  );

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
              onToggleSecondarySidebar={secondarySidebar.toggle}
              secondarySidebarOpen={!secondarySidebar.collapsed}
              spaceSwitcher={spaceSwitcher}
            />
          )}

          <main className="zoom-content flex min-h-0 flex-1 flex-col">
            <ResizablePanelGroup
              orientation="horizontal"
              className="min-h-0 flex-1"
              onLayoutChanged={commitWorkbenchLayout}
            >
              <ResizablePanel
                id="primary-sidebar"
                panelRef={sidebarRef}
                groupResizeBehavior="preserve-pixel-size"
                defaultSize={
                  initialSidebarCollapsed
                    ? "0px"
                    : `${sidebarWidthRef.current}px`
                }
                minSize={`${SIDEBAR_MIN_WIDTH}px`}
                maxSize={`${SIDEBAR_MAX_WIDTH}px`}
                collapsible
                collapsedSize={0}
              >
                <div
                  className={cn(
                    "sidebar-scrollbar-scope flex h-full min-h-0 flex-col border-r border-border/60 bg-sidebar transition-[opacity,translate] duration-pane ease-standard",
                    sidebarCollapsed
                      ? "pointer-events-none -translate-x-1.5 opacity-0"
                      : "translate-x-0 opacity-100",
                  )}
                >
                  <SidebarRail
                    activeView={sidebarView}
                    onSelectView={persistSidebarView}
                    changedCount={sourceControl.changedCount}
                  />
                  <div key={sidebarView} className="min-h-0 flex-1">
                    {sidebarView === "explorer" ? (
                      <FileExplorer
                        ref={explorerRef}
                        rootPath={explorerRoot}
                        gitStatus={
                          explorerGitDecorations ? sourceControl.status : null
                        }
                        activeFilePath={explorerActiveFilePath}
                        onOpenFile={handleOpenFile}
                        onPathRenamed={handlePathRenamed}
                        onPathDeleted={handlePathDeleted}
                        onRevealInTerminal={cdInNewTab}
                        onAttachToAgent={handleAttachFileToAgent}
                        onDropToWorkbench={handleDropFileToWorkbench}
                      />
                    ) : (
                      <SourceControlViewContainer
                        open
                        sourceControl={sourceControl}
                        onOpenDiff={openGitDiffTab}
                        onOpenGitGraph={openGitGraphFromContext}
                        fullGraphOpen={activeTab?.kind === "git-history"}
                        onOpenCommitFile={openCommitFileDiffTab}
                        onOpenFile={handleOpenFile}
                        onNavigateToPath={cdInNewTab}
                      />
                    )}
                  </div>
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel
                id="workspace"
                defaultSize="78%"
                minSize={`${WORKSPACE_MIN_WIDTH}px`}
              >
                <div className="flex h-full min-h-0 flex-col">
                  <div className="relative min-h-0 flex-1">
                    <WorkbenchSurface
                      state={workbenchState}
                      activeSpaceId={activeSpaceId ?? DEFAULT_SPACE_ID}
                      actions={workbenchActions}
                      services={workbenchServices}
                    />
                  </div>

                  <WorkspaceInputBar
                    isBlockTab={isBlockTab}
                    isTerminalTab={isTerminalTab}
                    terminalId={activeTerminalId}
                    cwd={activeCwd}
                    home={home}
                  />
                </div>
              </ResizablePanel>
              <ResizableHandle
                withHandle
                disabled={secondarySidebar.collapsed}
              />
              <ResizablePanel
                id="secondary-sidebar"
                panelRef={secondarySidebar.panelRef}
                groupResizeBehavior="preserve-pixel-size"
                defaultSize={
                  secondarySidebar.initialCollapsed
                    ? "0px"
                    : `${secondarySidebar.widthRef.current}px`
                }
                minSize={`${SECONDARY_SIDEBAR_MIN_WIDTH}px`}
                maxSize={`${SECONDARY_SIDEBAR_MAX_WIDTH}px`}
                collapsible
                collapsedSize={0}
              >
                <div
                  className={cn(
                    "h-full min-h-0 transition-[opacity,translate] duration-pane ease-standard",
                    secondarySidebar.collapsed
                      ? "pointer-events-none translate-x-1.5 opacity-0"
                      : "translate-x-0 opacity-100",
                  )}
                >
                  <SecondarySidebar
                    views={
                      secondarySidebar.collapsed ? [] : secondarySidebarViews
                    }
                    activeView={secondarySidebar.activeView}
                    onSelectView={secondarySidebar.persistView}
                  />
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </main>

          {!zenMode && (
            <StatusBar
              cwd={activeCwd}
              filePath={activeFilePath}
              home={home}
              workspaceError={environmentError}
              onWorkspaceRetry={initializeWorkspaceEnv}
              onCd={sendCd}
              onWorkspaceChange={handleWorkspaceChange}
              onToggleAi={toggleAiPanel}
              aiOpen={!secondarySidebar.collapsed}
              privateActive={
                activeTab?.kind === "terminal" && activeTab.private === true
              }
            />
          )}

          <AgentNotificationsBridge
            tabs={tabs}
            activeId={activeId}
            onActivate={onActivateAgent}
          />
          <HostKeyDialog prompt={hostPrompt} onResolved={clearHostPrompt} />
          <Toaster position="bottom-right" />

          {hasComposer ? (
            <>
              <AgentRunBridge
                openAiDiffTab={openAiDiffTab}
                closeAiDiffTab={closeAiDiffTab}
              />
              <LocalAgentNotificationsBridge
                visible={!secondarySidebar.collapsed}
                onActivate={openAiPanel}
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

  return <AiComposerProvider>{shell}</AiComposerProvider>;
}

import {
  activateGroup,
  activateTab,
  activeTabId,
  addTabToGroup,
  allTabs,
  closeTab as closeTabInState,
  createSpaceWorkbench,
  findGroupForTab,
  groupIds,
  moveTabToGroup as moveTabInState,
  reorderTabByGap as reorderTabByGapInState,
  splitWithTab,
  tabsForSpace,
  updateSplitSizes,
} from "@/modules/workbench/model";
import {
  type AiDiffStatus,
  DEFAULT_SPACE_ID,
  type EditorTab,
  type GitCommitFileDiffTab,
  type GitDiffTab,
  type GitHistoryTab,
  type MarkdownTab,
  type PreviewTab,
  type SpaceWorkbench,
  type Tab,
  type TabPatch,
  type TerminalTab,
  type WorkbenchDirection,
  type WorkbenchState,
} from "@/modules/workbench/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function titleFromUrl(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url || "preview";
  }
}

function createInitialState(initial?: Partial<TerminalTab>): WorkbenchState {
  const tab: TerminalTab = {
    id: 3,
    kind: "terminal",
    terminalId: 4,
    spaceId: DEFAULT_SPACE_ID,
    cold: true,
    title: initial?.title ?? "shell",
    cwd: initial?.cwd,
  };
  return {
    tabs: { [tab.id]: tab },
    spaces: {
      [DEFAULT_SPACE_ID]: createSpaceWorkbench(1, 2, tab.id),
    },
  };
}

function firstGroupId(space: SpaceWorkbench): number {
  return groupIds(space.root)[0];
}

function patchTab(
  state: WorkbenchState,
  id: number,
  patch: TabPatch,
): WorkbenchState {
  const tab = state.tabs[id];
  if (!tab) return state;
  let next: Tab;
  if (tab.kind === "terminal") {
    next = {
      ...tab,
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.cwd !== undefined && { cwd: patch.cwd }),
      ...(patch.customTitle !== undefined && {
        customTitle: patch.customTitle || undefined,
      }),
    };
  } else if (tab.kind === "preview") {
    next = {
      ...tab,
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.url !== undefined && {
        url: patch.url,
        title: patch.title ?? titleFromUrl(patch.url),
      }),
    };
  } else if (tab.kind === "markdown") {
    next = {
      ...tab,
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.path !== undefined && { path: patch.path }),
      ...(patch.dirty !== undefined && { dirty: patch.dirty }),
      ...(patch.explorerRoot !== undefined && {
        explorerRoot: patch.explorerRoot,
      }),
    };
  } else if (tab.kind === "editor") {
    next = {
      ...tab,
      ...(patch.dirty === true && tab.preview && { preview: false }),
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.path !== undefined && { path: patch.path }),
      ...(patch.dirty !== undefined && { dirty: patch.dirty }),
      ...(patch.overrideLanguage !== undefined && {
        overrideLanguage: patch.overrideLanguage,
      }),
      ...(patch.explorerRoot !== undefined && {
        explorerRoot: patch.explorerRoot,
      }),
    };
  } else {
    if (patch.title === undefined) return state;
    next = { ...tab, title: patch.title };
  }
  return { ...state, tabs: { ...state.tabs, [id]: next } };
}

function replacePreview(
  state: WorkbenchState,
  groupId: number,
  previousId: number,
  tab: EditorTab,
): WorkbenchState {
  const owner = findGroupForTab(state, previousId);
  if (!owner || owner.group.id !== groupId) return state;
  const tabs = { ...state.tabs };
  delete tabs[previousId];
  tabs[tab.id] = tab;
  const tabIds = owner.group.tabIds.map((id) =>
    id === previousId ? tab.id : id,
  );
  return {
    ...state,
    tabs,
    spaces: {
      ...state.spaces,
      [owner.spaceId]: {
        ...state.spaces[owner.spaceId],
        activeGroupId: groupId,
        groups: {
          ...state.spaces[owner.spaceId].groups,
          [groupId]: { ...owner.group, tabIds, activeTabId: tab.id },
        },
      },
    },
  };
}

function cloneForSplit(tab: Tab, id: number, terminalId: number): Tab | null {
  switch (tab.kind) {
    case "terminal":
      return { ...tab, id, terminalId, cold: false };
    case "editor":
      return tab.dirty ? null : { ...tab, id, preview: false, cold: false };
    case "markdown":
      return tab.dirty ? null : { ...tab, id, cold: false };
    case "ai-diff":
      return null;
    default:
      return { ...tab, id, cold: false };
  }
}

function maxRuntimeId(state: WorkbenchState): number {
  let max = 0;
  const visit = (node: SpaceWorkbench["root"]) => {
    max = Math.max(max, node.id);
    if (node.kind === "split") node.children.forEach(visit);
  };
  for (const tab of Object.values(state.tabs)) {
    max = Math.max(max, tab.id);
    if (tab.kind === "terminal") max = Math.max(max, tab.terminalId);
  }
  for (const space of Object.values(state.spaces)) {
    visit(space.root);
    for (const id of Object.keys(space.groups)) max = Math.max(max, Number(id));
  }
  return max;
}

export function useWorkbench(initial?: Partial<TerminalTab>) {
  const [state, setState] = useState(() => createInitialState(initial));
  const stateRef = useRef(state);
  const nextIdRef = useRef(5);
  const [booted, setBooted] = useState(false);
  const [activeSpaceId, setActiveSpaceId] = useState(DEFAULT_SPACE_ID);
  const activeSpaceIdRef = useRef(activeSpaceId);

  const commit = useCallback(
    (update: (current: WorkbenchState) => WorkbenchState) => {
      const current = stateRef.current;
      const next = update(current);
      if (next !== current) {
        stateRef.current = next;
        setState(next);
      }
      return next;
    },
    [],
  );

  const allocId = useCallback(() => nextIdRef.current++, []);

  const setActiveSpace = useCallback((spaceId: string) => {
    activeSpaceIdRef.current = spaceId;
    setActiveSpaceId(spaceId);
  }, []);

  const replaceWorkbench = useCallback(
    (next: WorkbenchState, nextActiveSpaceId: string) => {
      if (!next.spaces[nextActiveSpaceId]) return;
      nextIdRef.current = maxRuntimeId(next) + 1;
      stateRef.current = next;
      setState(next);
      setActiveSpace(nextActiveSpaceId);
    },
    [setActiveSpace],
  );

  const markBooted = useCallback(() => setBooted(true), []);

  useEffect(() => {
    if (!booted) return;
    commit((current) => {
      const space = current.spaces[activeSpaceId];
      if (!space) return current;
      const coldIds = Object.values(space.groups)
        .map((group) => group.activeTabId)
        .filter((id) => current.tabs[id]?.cold);
      if (coldIds.length === 0) return current;
      const tabs = { ...current.tabs };
      for (const id of coldIds) tabs[id] = { ...tabs[id], cold: false };
      return { ...current, tabs };
    });
  }, [activeSpaceId, booted, commit]);

  const tabs = useMemo(() => allTabs(state), [state]);
  const activeId = activeTabId(state, activeSpaceId) ?? 0;
  const setActiveId = useCallback(
    (id: number) => commit((current) => activateTab(current, id)),
    [commit],
  );

  const setActiveGroup = useCallback(
    (groupId: number) =>
      commit((current) =>
        activateGroup(current, activeSpaceIdRef.current, groupId),
      ),
    [commit],
  );

  const targetGroup = useCallback((spaceId = activeSpaceIdRef.current) => {
    const space = stateRef.current.spaces[spaceId];
    return space?.activeGroupId ?? (space ? firstGroupId(space) : null);
  }, []);

  const addPage = useCallback(
    (tab: Tab, groupId?: number, activate = true) => {
      const target = groupId ?? targetGroup(tab.spaceId);
      if (target === null) return false;
      commit((current) =>
        addTabToGroup(current, tab, target, undefined, activate),
      );
      return true;
    },
    [commit, targetGroup],
  );

  const createSpace = useCallback(
    (spaceId: string, cwd?: string, activate = true) => {
      if (stateRef.current.spaces[spaceId]) {
        if (activate) setActiveSpace(spaceId);
        return stateRef.current.spaces[spaceId].groups[
          stateRef.current.spaces[spaceId].activeGroupId
        ].activeTabId;
      }
      const groupId = allocId();
      const nodeId = allocId();
      const tabId = allocId();
      const terminalId = allocId();
      const tab: TerminalTab = {
        id: tabId,
        terminalId,
        kind: "terminal",
        spaceId,
        cold: true,
        title: cwd ? basename(cwd) : "shell",
        cwd,
      };
      commit((current) => ({
        tabs: { ...current.tabs, [tabId]: tab },
        spaces: {
          ...current.spaces,
          [spaceId]: createSpaceWorkbench(groupId, nodeId, tabId),
        },
      }));
      if (activate) setActiveSpace(spaceId);
      return tabId;
    },
    [allocId, commit, setActiveSpace],
  );

  const newTerminalTab = useCallback(
    (
      cwd: string | undefined,
      options: Pick<TerminalTab, "title" | "blocks" | "private">,
      spaceId = activeSpaceIdRef.current,
      groupId?: number,
      activate = true,
    ) => {
      if (!stateRef.current.spaces[spaceId]) {
        return createSpace(spaceId, cwd, activate);
      }
      const tabId = allocId();
      const terminalId = allocId();
      const tab: TerminalTab = {
        id: tabId,
        terminalId,
        kind: "terminal",
        spaceId,
        title: options.title,
        cwd,
        ...(options.blocks && { blocks: true }),
        ...(options.private && { private: true }),
        ...(!activate && { cold: true }),
      };
      addPage(tab, groupId, activate);
      return tabId;
    },
    [addPage, allocId, createSpace],
  );

  const newTab = useCallback(
    (cwd?: string, groupId?: number) =>
      newTerminalTab(cwd, { title: "shell" }, undefined, groupId),
    [newTerminalTab],
  );

  const newBlockTab = useCallback(
    (cwd?: string, groupId?: number) =>
      newTerminalTab(
        cwd,
        { title: "blocks", blocks: true },
        undefined,
        groupId,
      ),
    [newTerminalTab],
  );

  const newPrivateTab = useCallback(
    (cwd?: string, groupId?: number) =>
      newTerminalTab(
        cwd,
        { title: "private", private: true },
        undefined,
        groupId,
      ),
    [newTerminalTab],
  );

  const newAgentTab = useCallback(
    (cwd: string | undefined, title: string) => {
      const tabId = newTerminalTab(cwd, { title });
      const tab = stateRef.current.tabs[tabId];
      return {
        tabId,
        leafId: tab.kind === "terminal" ? tab.terminalId : 0,
      };
    },
    [newTerminalTab],
  );

  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return;
    (
      window as unknown as { __teraxNewBlockTab?: (cwd?: string) => number }
    ).__teraxNewBlockTab = newBlockTab;
  }, [newBlockTab]);

  const newTabInSpace = useCallback(
    (spaceId: string, cwd?: string) =>
      newTerminalTab(cwd, { title: "shell" }, spaceId, undefined, false),
    [newTerminalTab],
  );

  const pinTab = useCallback(
    (id: number) =>
      commit((current) => {
        const tab = current.tabs[id];
        if (tab?.kind !== "editor" || !tab.preview) return current;
        return {
          ...current,
          tabs: { ...current.tabs, [id]: { ...tab, preview: false } },
        };
      }),
    [commit],
  );

  const openFileTab = useCallback(
    (path: string, pin = true, explorerRoot?: string, groupId?: number) => {
      const spaceId = activeSpaceIdRef.current;
      const target = groupId ?? targetGroup(spaceId);
      if (target === null) return null;
      const group = stateRef.current.spaces[spaceId]?.groups[target];
      if (!group) return null;
      const editorTabs = group.tabIds
        .map((id) => stateRef.current.tabs[id])
        .filter((tab): tab is EditorTab => tab?.kind === "editor");
      const existing = editorTabs.find((tab) => tab.path === path);
      if (existing) {
        commit((current) => {
          const activated = activateTab(current, existing.id);
          return pin && existing.preview
            ? patchTab(activated, existing.id, {
                dirty: existing.dirty,
                explorerRoot,
              })
            : activated;
        });
        if (pin && existing.preview) pinTab(existing.id);
        return existing.id;
      }
      const id = allocId();
      const tab: EditorTab = {
        id,
        kind: "editor",
        spaceId,
        title: basename(path),
        path,
        dirty: false,
        preview: !pin,
        ...(explorerRoot !== undefined && { explorerRoot }),
      };
      if (!pin) {
        const preview = editorTabs.find((candidate) => candidate.preview);
        if (preview) {
          commit((current) => replacePreview(current, target, preview.id, tab));
          return id;
        }
      }
      addPage(tab, target);
      return id;
    },
    [addPage, allocId, commit, pinTab, targetGroup],
  );

  const newMarkdownTab = useCallback(
    (path: string, explorerRoot?: string, groupId?: number) => {
      const spaceId = activeSpaceIdRef.current;
      const target = groupId ?? targetGroup(spaceId);
      if (target === null) return null;
      const group = stateRef.current.spaces[spaceId]?.groups[target];
      const existing = group?.tabIds
        .map((id) => stateRef.current.tabs[id])
        .find((tab): tab is MarkdownTab =>
          Boolean(tab?.kind === "markdown" && tab.path === path),
        );
      if (existing) {
        commit((current) => activateTab(current, existing.id));
        return existing.id;
      }
      const id = allocId();
      addPage(
        {
          id,
          kind: "markdown",
          spaceId,
          title: basename(path),
          path,
          dirty: false,
          ...(explorerRoot !== undefined && { explorerRoot }),
        },
        target,
      );
      return id;
    },
    [addPage, allocId, commit, targetGroup],
  );

  const newPreviewTab = useCallback(
    (url: string, groupId?: number) => {
      const id = allocId();
      const tab: PreviewTab = {
        id,
        kind: "preview",
        spaceId: activeSpaceIdRef.current,
        title: titleFromUrl(url),
        url,
      };
      addPage(tab, groupId);
      return id;
    },
    [addPage, allocId],
  );

  const openAiDiffTab = useCallback(
    (input: {
      path: string;
      originalContent: string;
      proposedContent: string;
      approvalId: string;
      isNewFile: boolean;
    }) => {
      const existing = Object.values(stateRef.current.tabs).find(
        (tab) => tab.kind === "ai-diff" && tab.approvalId === input.approvalId,
      );
      if (existing) {
        setActiveId(existing.id);
        return existing.id;
      }
      const id = allocId();
      addPage({
        id,
        kind: "ai-diff",
        spaceId: activeSpaceIdRef.current,
        title: `${basename(input.path)} (AI diff)`,
        path: input.path,
        originalContent: input.originalContent,
        proposedContent: input.proposedContent,
        approvalId: input.approvalId,
        status: "pending",
        isNewFile: input.isNewFile,
      });
      return id;
    },
    [addPage, allocId, setActiveId],
  );

  const setAiDiffStatus = useCallback(
    (approvalId: string, status: AiDiffStatus) =>
      commit((current) => {
        const tab = Object.values(current.tabs).find(
          (candidate) =>
            candidate.kind === "ai-diff" && candidate.approvalId === approvalId,
        );
        if (tab?.kind !== "ai-diff") return current;
        return {
          ...current,
          tabs: { ...current.tabs, [tab.id]: { ...tab, status } },
        };
      }),
    [commit],
  );

  const closeTab = useCallback(
    (id: number) => commit((current) => closeTabInState(current, id)),
    [commit],
  );

  const closeAiDiffTab = useCallback(
    (approvalId: string) => {
      const target = Object.values(stateRef.current.tabs).find(
        (tab) => tab.kind === "ai-diff" && tab.approvalId === approvalId,
      );
      if (!target) return;
      const before = stateRef.current;
      const next = closeTab(target.id);
      if (next === before) setAiDiffStatus(approvalId, "approved");
    },
    [closeTab, setAiDiffStatus],
  );

  const openGitDiffTab = useCallback(
    (input: {
      path: string;
      repoRoot: string;
      mode: "-" | "+";
      originalPath?: string | null;
      title?: string;
    }) => {
      const existing = Object.values(stateRef.current.tabs).find(
        (tab) =>
          tab.kind === "git-diff" &&
          tab.repoRoot === input.repoRoot &&
          tab.path === input.path &&
          tab.mode === input.mode,
      );
      if (existing) {
        commit((current) =>
          activateTab(
            patchTab(current, existing.id, {
              title: input.title ?? `${basename(input.path)} (${input.mode})`,
            }),
            existing.id,
          ),
        );
        return existing.id;
      }
      const id = allocId();
      const tab: GitDiffTab = {
        id,
        kind: "git-diff",
        spaceId: activeSpaceIdRef.current,
        title: input.title ?? `${basename(input.path)} (${input.mode})`,
        path: input.path,
        repoRoot: input.repoRoot,
        mode: input.mode,
        originalPath: input.originalPath ?? null,
      };
      addPage(tab);
      return id;
    },
    [addPage, allocId, commit],
  );

  const openCommitHistoryTab = useCallback(
    (input: { repoRoot: string; branch?: string | null }) => {
      const title = input.branch ? `History · ${input.branch}` : "Git History";
      const existing = Object.values(stateRef.current.tabs).find(
        (tab) => tab.kind === "git-history" && tab.repoRoot === input.repoRoot,
      );
      if (existing) {
        commit((current) =>
          activateTab(patchTab(current, existing.id, { title }), existing.id),
        );
        return existing.id;
      }
      const id = allocId();
      const tab: GitHistoryTab = {
        id,
        kind: "git-history",
        spaceId: activeSpaceIdRef.current,
        title,
        repoRoot: input.repoRoot,
      };
      addPage(tab);
      return id;
    },
    [addPage, allocId, commit],
  );

  const openCommitFileDiffTab = useCallback(
    (input: {
      repoRoot: string;
      sha: string;
      shortSha: string;
      subject: string;
      path: string;
      originalPath: string | null;
    }) => {
      const existing = Object.values(stateRef.current.tabs).find(
        (tab) =>
          tab.kind === "git-commit-file" &&
          tab.repoRoot === input.repoRoot &&
          tab.sha === input.sha &&
          tab.path === input.path,
      );
      if (existing) {
        setActiveId(existing.id);
        return existing.id;
      }
      const id = allocId();
      const tab: GitCommitFileDiffTab = {
        id,
        kind: "git-commit-file",
        spaceId: activeSpaceIdRef.current,
        title: `${basename(input.path)} @ ${input.shortSha}`,
        ...input,
      };
      addPage(tab);
      return id;
    },
    [addPage, allocId, setActiveId],
  );

  const updateTab = useCallback(
    (id: number, patch: TabPatch) =>
      commit((current) => patchTab(current, id, patch)),
    [commit],
  );

  const setOverrideLanguage = useCallback(
    (id: number, language: string | null) =>
      updateTab(id, { overrideLanguage: language }),
    [updateTab],
  );

  const setTerminalCwd = useCallback(
    (terminalId: number, cwd: string) =>
      commit((current) => {
        const tab = Object.values(current.tabs).find(
          (candidate) =>
            candidate.kind === "terminal" &&
            candidate.terminalId === terminalId,
        );
        return tab?.kind === "terminal" && tab.cwd !== cwd
          ? patchTab(current, tab.id, { cwd })
          : current;
      }),
    [commit],
  );

  const moveTabToGroup = useCallback(
    (tabId: number, groupId: number, index?: number) => {
      const current = stateRef.current;
      const source = findGroupForTab(current, tabId);
      const targetSpaceId = Object.entries(current.spaces).find(([, space]) =>
        Boolean(space.groups[groupId]),
      )?.[0];
      const sourceTab = current.tabs[tabId];
      if (
        source &&
        sourceTab &&
        targetSpaceId &&
        source.spaceId !== targetSpaceId &&
        tabsForSpace(current, source.spaceId).length === 1
      ) {
        newTerminalTab(
          sourceTab.kind === "terminal" ? sourceTab.cwd : undefined,
          { title: "shell" },
          source.spaceId,
          source.group.id,
          false,
        );
      }
      return commit((latest) => moveTabInState(latest, tabId, groupId, index));
    },
    [commit, newTerminalTab],
  );

  const reorderTabByGap = useCallback(
    (tabId: number, gap: number) =>
      commit((current) => reorderTabByGapInState(current, tabId, gap)),
    [commit],
  );

  const splitTab = useCallback(
    (
      tabId: number,
      direction: WorkbenchDirection,
      move = false,
      targetGroupId?: number,
    ) => {
      const current = stateRef.current;
      const source = current.tabs[tabId];
      const owner = findGroupForTab(current, tabId);
      const target = targetGroupId ?? owner?.group.id;
      if (!source || target === undefined) return null;
      const targetSpaceId = Object.entries(current.spaces).find(([, space]) =>
        Boolean(space.groups[target]),
      )?.[0];
      if (
        move &&
        owner &&
        targetSpaceId &&
        owner.spaceId !== targetSpaceId &&
        tabsForSpace(current, owner.spaceId).length === 1
      ) {
        newTerminalTab(
          source.kind === "terminal" ? source.cwd : undefined,
          { title: "shell" },
          owner.spaceId,
          owner.group.id,
          false,
        );
      }
      const nextTab = move
        ? source
        : cloneForSplit(source, allocId(), allocId());
      if (!nextTab) return null;
      const groupId = allocId();
      const nodeId = allocId();
      const splitId = allocId();
      const next = commit((stateNow) =>
        splitWithTab(
          stateNow,
          nextTab,
          target,
          groupId,
          nodeId,
          splitId,
          direction,
          move,
        ),
      );
      return next === current ? null : nextTab.id;
    },
    [allocId, commit, newTerminalTab],
  );

  const focusGroup = useCallback(
    (delta: 1 | -1) => {
      const space = stateRef.current.spaces[activeSpaceIdRef.current];
      if (!space) return;
      const ids = groupIds(space.root);
      const index = ids.indexOf(space.activeGroupId);
      const next = ids[(index + delta + ids.length) % ids.length];
      setActiveGroup(next);
    },
    [setActiveGroup],
  );

  const resizeSplit = useCallback(
    (splitId: number, sizes: number[]) =>
      commit((current) => {
        const spaceId = activeSpaceIdRef.current;
        const space = current.spaces[spaceId];
        if (!space) return current;
        const root = updateSplitSizes(space.root, splitId, sizes);
        return root === space.root
          ? current
          : {
              ...current,
              spaces: {
                ...current.spaces,
                [spaceId]: { ...space, root },
              },
            };
      }),
    [commit],
  );

  const selectByIndex = useCallback(
    (index: number, spaceId = activeSpaceIdRef.current) => {
      const tab = tabsForSpace(stateRef.current, spaceId)[index];
      if (tab) setActiveId(tab.id);
    },
    [setActiveId],
  );

  const removeSpace = useCallback(
    (spaceId: string, fallbackSpaceId: string, fallbackCwd?: string) => {
      if (!stateRef.current.spaces[spaceId]) return;
      if (!stateRef.current.spaces[fallbackSpaceId]) {
        createSpace(fallbackSpaceId, fallbackCwd, false);
      }
      commit((current) => {
        const tabs = { ...current.tabs };
        for (const tab of tabsForSpace(current, spaceId)) {
          delete tabs[tab.id];
        }
        const spaces = { ...current.spaces };
        delete spaces[spaceId];
        return { tabs, spaces };
      });
      if (activeSpaceIdRef.current === spaceId) setActiveSpace(fallbackSpaceId);
    },
    [commit, createSpace, setActiveSpace],
  );

  const closeExitedTerminal = useCallback(
    (tabId: number) => {
      const current = stateRef.current;
      const tab = current.tabs[tabId];
      const owner = findGroupForTab(current, tabId);
      if (tab?.kind !== "terminal" || !owner) return;
      if (tabsForSpace(current, owner.spaceId).length === 1) {
        newTerminalTab(
          tab.cwd,
          { title: "shell" },
          owner.spaceId,
          owner.group.id,
        );
      }
      closeTab(tabId);
    },
    [closeTab, newTerminalTab],
  );

  const moveTabToSpace = useCallback(
    (tabId: number, targetSpaceId: string) => {
      const current = stateRef.current;
      const tab = current.tabs[tabId];
      const owner = findGroupForTab(current, tabId);
      if (!tab || !owner || owner.spaceId === targetSpaceId) return false;
      if (!current.spaces[targetSpaceId])
        createSpace(targetSpaceId, undefined, false);
      const sourceWasLast =
        tabsForSpace(stateRef.current, owner.spaceId).length === 1;
      if (sourceWasLast) {
        newTerminalTab(
          tab.kind === "terminal" ? tab.cwd : undefined,
          { title: "shell" },
          owner.spaceId,
          owner.group.id,
          false,
        );
      }
      const target = stateRef.current.spaces[targetSpaceId].activeGroupId;
      moveTabToGroup(tabId, target);
      return activeSpaceIdRef.current === owner.spaceId && sourceWasLast;
    },
    [createSpace, moveTabToGroup, newTerminalTab],
  );

  const reorderTab = useCallback(
    (tabId: number, targetTabId: number, edge: "top" | "bottom") => {
      const current = stateRef.current;
      const source = findGroupForTab(current, tabId);
      const target = findGroupForTab(current, targetTabId);
      if (!source || !target || tabId === targetTabId) return false;
      const crossedSpace = source.spaceId !== target.spaceId;
      const follow = crossedSpace
        ? moveTabToSpace(tabId, target.spaceId)
        : false;
      const group =
        stateRef.current.spaces[target.spaceId].groups[target.group.id];
      const targetIndex = group.tabIds.indexOf(targetTabId);
      moveTabToGroup(
        tabId,
        target.group.id,
        edge === "bottom" ? targetIndex + 1 : targetIndex,
      );
      return follow;
    },
    [moveTabToGroup, moveTabToSpace],
  );

  return {
    state,
    tabs,
    activeId,
    allocId,
    markBooted,
    replaceWorkbench,
    setActiveSpace,
    setActiveId,
    setActiveGroup,
    createSpace,
    removeSpace,
    closeExitedTerminal,
    moveTabToSpace,
    moveTabToGroup,
    reorderTab,
    reorderTabByGap,
    splitTab,
    focusGroup,
    resizeSplit,
    newTabInSpace,
    newTab,
    newBlockTab,
    newAgentTab,
    newPrivateTab,
    openFileTab,
    pinTab,
    newPreviewTab,
    newMarkdownTab,
    openAiDiffTab,
    openGitDiffTab,
    openCommitHistoryTab,
    openCommitFileDiffTab,
    closeAiDiffTab,
    closeTab,
    updateTab,
    setOverrideLanguage,
    setTerminalCwd,
    selectByIndex,
  };
}

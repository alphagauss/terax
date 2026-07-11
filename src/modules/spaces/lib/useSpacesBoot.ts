import { native } from "@/modules/ai/lib/native";
import type { Tab } from "@/modules/tabs";
import { DEFAULT_SPACE_ID } from "@/modules/tabs/lib/useTabs";
import { isLeaf, type PaneNode } from "@/modules/terminal/lib/panes";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { currentWorkspaceBootstrap } from "@/modules/workspace-process";
import { useEffect, useRef } from "react";
import {
  canBootWorkspaceEnvironment,
  findActiveSpace,
  initialWorkspaceRoot,
} from "./activeSpace";
import { freshTerminalTab, hydrateTabs } from "./serialize";
import { loadAll, type SpaceMeta, saveActiveId, saveSpacesList } from "./store";
import { useSpaces } from "./useSpaces";

type Params = {
  ready: boolean;
  allocId: () => number;
  replaceTabs: (tabs: Tab[], activeId: number) => void;
  markBooted: () => void;
  setActiveSpaceForNewTabs: (id: string) => void;
  initializeWorkspaceEnv: () => Promise<string | null>;
  environmentHome: string | null;
};

export async function prepareWorkspaceBoot<T>(
  env: ReturnType<typeof currentWorkspaceEnv>,
  environmentHome: string | null,
  initializeWorkspaceEnv: () => Promise<string | null>,
  loadWorkspaceState: () => Promise<T>,
): Promise<{ resolvedHome: string | null; loaded: T } | null> {
  const resolvedHome = environmentHome ?? (await initializeWorkspaceEnv());
  if (!canBootWorkspaceEnvironment(env, resolvedHome)) return null;
  return { resolvedHome, loaded: await loadWorkspaceState() };
}

function uniqueCwds(tabs: Tab[]): string[] {
  const set = new Set<string>();
  const walk = (n: PaneNode) => {
    if (isLeaf(n)) {
      if (n.cwd) set.add(n.cwd);
      return;
    }
    for (const c of n.children) walk(c);
  };
  for (const t of tabs) {
    if (t.kind === "terminal") walk(t.paneTree);
    if ((t.kind === "editor" || t.kind === "markdown") && t.explorerRoot) {
      set.add(t.explorerRoot);
    }
  }
  return [...set];
}

export function useSpacesBoot({
  ready,
  allocId,
  replaceTabs,
  markBooted,
  setActiveSpaceForNewTabs,
  initializeWorkspaceEnv,
  environmentHome,
}: Params) {
  const done = useRef(false);

  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;

    void (async () => {
      try {
        const env = currentWorkspaceEnv();
        const prepared = await prepareWorkspaceBoot(
          env,
          environmentHome,
          initializeWorkspaceEnv,
          loadAll,
        );
        if (!prepared) {
          done.current = false;
          return;
        }
        const { resolvedHome, loaded } = prepared;
        const { spaces, activeId, states } = loaded;

        if (spaces.length === 0) {
          const root = initialWorkspaceRoot(
            env,
            currentWorkspaceBootstrap().launchDir,
            resolvedHome,
          );
          const meta: SpaceMeta = {
            id: DEFAULT_SPACE_ID,
            name: "Default",
            root,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const tab = freshTerminalTab(DEFAULT_SPACE_ID, root, allocId);
          await saveSpacesList([meta]);
          await saveActiveId(DEFAULT_SPACE_ID);
          setActiveSpaceForNewTabs(DEFAULT_SPACE_ID);
          useSpaces.getState().hydrate([meta], DEFAULT_SPACE_ID);
          replaceTabs([tab], tab.id);
          return;
        }

        const restored: Tab[] = [];
        for (const space of spaces) {
          const st = states.get(space.id);
          if (!st) continue;
          restored.push(...hydrateTabs(st.tabs, space.id, allocId));
        }

        const active =
          activeId && spaces.some((s) => s.id === activeId)
            ? activeId
            : spaces[0].id;
        setActiveSpaceForNewTabs(active);

        if (!restored.some((t) => t.spaceId === active)) {
          const root = findActiveSpace(spaces, active)?.root ?? resolvedHome;
          restored.push(freshTerminalTab(active, root, allocId));
        }

        await Promise.allSettled(
          uniqueCwds(restored).map((cwd) => native.workspaceAuthorize(cwd)),
        );

        const initialActiveIndex: Record<string, number> = {};
        for (const [id, st] of states)
          initialActiveIndex[id] = st.activeTabIndex;
        useSpaces.getState().hydrate(spaces, active, initialActiveIndex);

        const inActive = restored.filter((t) => t.spaceId === active);
        const idx = states.get(active)?.activeTabIndex ?? 0;
        const activeTab = inActive[idx] ?? inActive[0] ?? restored[0];
        replaceTabs(restored, activeTab.id);
      } catch (e) {
        console.error("[terax] spaces boot failed:", e);
      } finally {
        if (done.current) markBooted();
      }
    })();
  }, [
    ready,
    allocId,
    replaceTabs,
    markBooted,
    setActiveSpaceForNewTabs,
    initializeWorkspaceEnv,
    environmentHome,
  ]);
}

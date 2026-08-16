/**
 * 本文件负责等待环境就绪并恢复当前 Workspace 的 Space 状态。
 * 新 Workspace 默认进入空态，显式 Local 启动目录仍创建对应终端。
 */

import { native } from "@/modules/ai/lib/native";
import { initialWorkspaceRoot } from "@/modules/spaces/lib/activeSpace";
import {
  freshSpaceWorkbench,
  hydrateSpaceWorkbench,
} from "@/modules/spaces/lib/serialize";
import {
  loadAll,
  type LoadedSpaces,
  type SpaceMeta,
  saveActiveId,
  saveSpacesList,
} from "@/modules/spaces/lib/store";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import {
  DEFAULT_SPACE_ID,
  type Tab,
  type WorkbenchState,
} from "@/modules/workbench/types";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { currentWorkspaceBootstrap } from "@/modules/workspace-process";
import { useEffect, useRef } from "react";

type Params = {
  ready: boolean;
  allocId: () => number;
  replaceWorkbench: (state: WorkbenchState, activeSpaceId: string) => void;
  markBooted: () => void;
  ensureWorkspaceReady: () => Promise<string | null>;
  environmentHome: string | null;
};

/** 剔除未被 Space 元数据引用的状态，避免默认 ID 碰撞时复活已删除页面。 */
function discardOrphanedStates(loaded: LoadedSpaces): LoadedSpaces {
  const referencedIds = new Set(loaded.spaces.map((space) => space.id));
  const states = new Map(
    [...loaded.states].filter(([spaceId]) => referencedIds.has(spaceId)),
  );
  return states.size === loaded.states.size ? loaded : { ...loaded, states };
}

/** 判断有效持久化状态中是否存在需要恢复的页面。 */
function restoredPagesNeedEnvironment(loaded: LoadedSpaces): boolean {
  return [...loaded.states.values()].some((state) => state.workbench !== null);
}

/**
 * 先读取本地 Space 布局，仅在恢复远端页面需要 Home 时等待环境就绪。
 *
 * 空的远端 Workspace 可直接恢复默认首页；SSH 的后台连接由环境 Hook 独立管理。
 */
export async function prepareWorkspaceBoot(
  env: ReturnType<typeof currentWorkspaceEnv>,
  environmentHome: string | null,
  ensureWorkspaceReady: () => Promise<string | null>,
  loadWorkspaceState: () => Promise<LoadedSpaces>,
): Promise<LoadedSpaces | null> {
  const loaded = discardOrphanedStates(await loadWorkspaceState());
  const needsEnvironment =
    env.kind === "local" || restoredPagesNeedEnvironment(loaded);
  if (!needsEnvironment) return loaded;

  const resolvedHome = environmentHome ?? (await ensureWorkspaceReady());
  if (env.kind !== "local" && !resolvedHome) return null;
  return loaded;
}

function uniqueCwds(tabs: Tab[]): string[] {
  const paths = new Set<string>();
  for (const tab of tabs) {
    if (tab.kind === "terminal" && tab.cwd) paths.add(tab.cwd);
    if (
      (tab.kind === "editor" || tab.kind === "markdown") &&
      tab.explorerRoot
    ) {
      paths.add(tab.explorerRoot);
    }
  }
  return [...paths];
}

export function useSpacesBoot({
  ready,
  allocId,
  replaceWorkbench,
  markBooted,
  ensureWorkspaceReady,
  environmentHome,
}: Params) {
  const done = useRef(false);

  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;

    void (async () => {
      try {
        const env = currentWorkspaceEnv();
        const loaded = await prepareWorkspaceBoot(
          env,
          environmentHome,
          ensureWorkspaceReady,
          loadAll,
        );
        if (!loaded) {
          done.current = false;
          return;
        }
        let spaces = loaded.spaces;
        let activeSpaceId = loaded.activeId;
        let createdSpaceId: string | null = null;

        if (spaces.length === 0) {
          const root = initialWorkspaceRoot(
            env,
            currentWorkspaceBootstrap().launchDir,
          );
          const meta: SpaceMeta = {
            id: DEFAULT_SPACE_ID,
            name: "Default",
            root,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          spaces = [meta];
          createdSpaceId = meta.id;
          activeSpaceId = meta.id;
          await saveSpacesList(spaces);
          await saveActiveId(meta.id);
        }

        const active =
          activeSpaceId && spaces.some((space) => space.id === activeSpaceId)
            ? activeSpaceId
            : spaces[0].id;
        const state: WorkbenchState = { tabs: {}, spaces: {} };

        for (const spaceMeta of spaces) {
          const persisted = loaded.states.get(spaceMeta.id);
          const restored = persisted
            ? persisted.workbench === null
              ? null
              : hydrateSpaceWorkbench(persisted.workbench, spaceMeta.id, allocId)
            : null;
          const workbench =
            restored ??
            freshSpaceWorkbench(
              spaceMeta.id,
              createdSpaceId === spaceMeta.id ? spaceMeta.root : null,
              allocId,
            );
          state.spaces[spaceMeta.id] = workbench.space;
          for (const tab of workbench.tabs) state.tabs[tab.id] = tab;
        }

        await Promise.allSettled(
          uniqueCwds(Object.values(state.tabs)).map((cwd) =>
            native.workspaceAuthorize(cwd),
          ),
        );

        useSpaces.getState().hydrate(spaces, active);
        replaceWorkbench(state, active);
      } catch (error) {
        console.error("[terax] spaces boot failed:", error);
      } finally {
        if (done.current) markBooted();
      }
    })();
  }, [
    ready,
    allocId,
    replaceWorkbench,
    markBooted,
    ensureWorkspaceReady,
    environmentHome,
  ]);
}

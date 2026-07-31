/**
 * 本文件负责等待环境就绪并恢复当前 Workspace 的 Space 状态。
 * 新 Workspace 默认进入空态，显式 Local 启动目录仍创建对应终端。
 */

import { native } from "@/modules/ai/lib/native";
import { getInitialAlphaShowInRemote } from "@/modules/alpha/preferences";
import {
  canBootWorkspaceEnvironment,
  initialWorkspaceRoot,
} from "@/modules/spaces/lib/activeSpace";
import {
  freshSpaceWorkbench,
  hydrateSpaceWorkbench,
} from "@/modules/spaces/lib/serialize";
import {
  loadAll,
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
        let spaces = loaded.spaces;
        let activeSpaceId = loaded.activeId;
        let createdSpaceId: string | null = null;

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
              : hydrateSpaceWorkbench(
                  persisted.workbench,
                  spaceMeta.id,
                  allocId,
                  {
                    allowAlphaPages:
                      env.kind === "local" || getInitialAlphaShowInRemote(),
                  },
                )
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
    initializeWorkspaceEnv,
    environmentHome,
  ]);
}

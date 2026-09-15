/**
 * 本文件在等待环境时恢复 Workspace 的 Space 状态，并提前报告 SSH 前台资源。
 * 新 Workspace 默认进入空态，显式 Local 启动目录仍创建对应终端。
 */

import { native } from "@/modules/ai/lib/native";
import { getInitialAlphaShowInRemote } from "@/modules/alpha/preferences";
import { type RemoteForegroundIntent, remoteNative } from "@/modules/remote";
import { initialWorkspaceRoot } from "@/modules/spaces/lib/activeSpace";
import {
  freshSpaceWorkbench,
  hydrateSpaceWorkbench,
  type SerializedTab,
  type SerializedWorkbenchNode,
} from "@/modules/spaces/lib/serialize";
import {
  type LoadedSpaces,
  loadAll,
  saveActiveId,
  saveSpacesList,
} from "@/modules/spaces/lib/store";
import {
  createDefaultSpace,
  withDefaultSpace,
  useSpaces,
} from "@/modules/spaces/lib/useSpaces";
import type { Tab, WorkbenchState } from "@/modules/workbench/types";
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

/** 页面或锁定目录需要准备环境，解锁空态不主动访问保存的旧根。 */
function restoredPagesNeedEnvironment(loaded: LoadedSpaces): boolean {
  return (
    loaded.spaces.some((space) => space.rootLocked && space.root) ||
    [...loaded.states.values()].some((state) => state.workbench !== null)
  );
}

/** 返回序列化布局中显式激活的可恢复标签。 */
function explicitlyActiveSerializedTab(
  node: SerializedWorkbenchNode,
): SerializedTab | null {
  if (node.kind === "group") {
    return node.active
      ? (node.tabs[node.activeTabIndex] ?? node.tabs[0] ?? null)
      : null;
  }
  for (const child of node.children) {
    const tab = explicitlyActiveSerializedTab(child);
    if (tab) return tab;
  }
  return null;
}

/** 返回序列化布局中的第一个可恢复标签，供缺少 active 标记的旧状态使用。 */
function firstSerializedTab(
  node: SerializedWorkbenchNode,
): SerializedTab | null {
  if (node.kind === "group") return node.tabs[0] ?? null;
  for (const child of node.children) {
    const tab = firstSerializedTab(child);
    if (tab) return tab;
  }
  return null;
}

/** 从本地恢复状态提取 SSH 启动阶段的前台资源提示。 */
export function foregroundIntentForLoadedSpaces(
  loaded: LoadedSpaces,
): RemoteForegroundIntent {
  const activeSpaceId =
    loaded.activeId &&
    loaded.spaces.some((space) => space.id === loaded.activeId)
      ? loaded.activeId
      : loaded.spaces[0]?.id;
  const workbench = activeSpaceId
    ? loaded.states.get(activeSpaceId)?.workbench
    : null;
  const space = loaded.spaces.find((item) => item.id === activeSpaceId);
  if (!workbench)
    return { kind: space?.rootLocked && space.root ? "explorer" : "none" };
  const tab =
    explicitlyActiveSerializedTab(workbench) ?? firstSerializedTab(workbench);
  return tab?.kind === "terminal"
    ? {
        kind: "terminal",
        cwd: tab.cwd ?? null,
        blocks: tab.blocks ?? false,
      }
    : { kind: "explorer" };
}

/**
 * 先读取本地 Space 状态，恢复远端页面或锁定目录时等待环境就绪。
 *
 * 没有目录与页面的远端 Workspace 直接恢复默认首页；SSH 后台连接由环境 Hook 独立管理。
 */
export async function prepareWorkspaceBoot(
  env: ReturnType<typeof currentWorkspaceEnv>,
  environmentHome: string | null,
  ensureWorkspaceReady: () => Promise<string | null>,
  loadWorkspaceState: () => Promise<LoadedSpaces>,
  onLoaded?: (loaded: LoadedSpaces) => Promise<void>,
): Promise<LoadedSpaces | null> {
  const loaded = discardOrphanedStates(await loadWorkspaceState());
  try {
    await onLoaded?.(loaded);
  } catch {
    // 前台提示只影响预热策略，不能阻止本地布局恢复。
  }
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
          env.kind === "ssh"
            ? (state) =>
                remoteNative.setForeground(
                  foregroundIntentForLoadedSpaces(state),
                )
            : undefined,
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
          const meta = createDefaultSpace(root);
          spaces = [meta];
          createdSpaceId = meta.id;
          activeSpaceId = meta.id;
          await saveActiveId(meta.id);
        }

        spaces = withDefaultSpace(spaces);
        await saveSpacesList(spaces);

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
          [
            ...new Set([
              ...uniqueCwds(Object.values(state.tabs)),
              ...spaces.flatMap((space) =>
                space.rootLocked && space.root ? [space.root] : [],
              ),
            ]),
          ].map((cwd) => native.workspaceAuthorize(cwd)),
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

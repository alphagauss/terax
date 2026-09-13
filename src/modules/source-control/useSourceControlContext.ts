/**
 * 本文件根据当前 Workbench 页面解析源代码管理仓库上下文。
 * 控制器常驻工作区根部，不依赖 Source Control 面板是否可见。
 */

import type { Tab } from "@/modules/workbench";
import { useMemo } from "react";
import { useRepositoryController } from "./useRepositoryController";

function dirname(path: string | null): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return normalized;
  return normalized.slice(0, idx);
}

type Params = {
  activeTab: Tab | undefined;
  tabs: Tab[];
  activeTerminalCwd: string | null;
  explorerRoot: string | null;
  launchCwd: string | null;
  launchCwdResolved: boolean;
  home: string | null;
  sourceControlVisible: boolean;
};

/**
 * 解析当前页面对应的 Git 上下文，并向侧边栏和徽标提供源代码管理摘要。
 *
 * 面板未显示时徽标使用稳定的 Explorer 根目录，避免标签切换或终端目录变化重复触发 Git IPC。
 */
export function useSourceControlContext({
  activeTab,
  tabs,
  activeTerminalCwd,
  explorerRoot,
  launchCwd,
  launchCwdResolved,
  home,
  sourceControlVisible,
}: Params) {
  const workspaceFallbackPath = launchCwdResolved
    ? (launchCwd ?? home ?? null)
    : null;
  const sourceControlContextPath = (() => {
    if (activeTab?.kind === "terminal") {
      return activeTerminalCwd ?? explorerRoot ?? workspaceFallbackPath;
    }
    if (activeTab?.kind === "editor") return dirname(activeTab.path);
    if (activeTab?.kind === "git-diff") return activeTab.repoRoot;
    if (activeTab?.kind === "git-commit-file") return activeTab.repoRoot;
    return explorerRoot ?? workspaceFallbackPath;
  })();
  const hasOpenGitTab = useMemo(
    () =>
      tabs.some((t) => t.kind === "git-diff" || t.kind === "git-commit-file"),
    [tabs],
  );
  const sourceControlActive = hasOpenGitTab || sourceControlVisible;
  // 非 Git 页面跟随 Explorer 根目录，使侧栏徽标和文件装饰始终对应用户正在查看的仓库。
  // 仓库内部切换目录产生的抖动由控制器的 TTL 与复用根目录逻辑吸收。
  const badgeContextPath = explorerRoot ?? workspaceFallbackPath;
  const sourceControlPath = sourceControlActive
    ? sourceControlContextPath
    : badgeContextPath;
  const sourceControl = useRepositoryController(sourceControlPath, true);

  return { sourceControl };
}

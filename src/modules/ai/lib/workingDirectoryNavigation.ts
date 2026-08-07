/**
 * 本文件解析 AI 历史会话工作目录对应的 Workbench 导航目标。
 * 路径比较遵循当前环境语义，只返回决策，不执行标签切换或目录访问。
 */

import { documentPathIdentity } from "@/lib/pathIdentity";
import type { WorkspaceEnv } from "@/modules/workspace";
import type { Tab } from "@/modules/workbench";

export type WorkingDirectoryTarget =
  | { kind: "none" }
  | { kind: "tab"; tabId: number }
  | { kind: "new-terminal" };

/** 规范目录身份，并保留 Unix 与 Windows 驱动器根目录的末尾分隔符。 */
function directoryIdentity(
  workspace: WorkspaceEnv,
  path: string,
  hostWindows?: boolean,
): string {
  const identity = documentPathIdentity(workspace, path, hostWindows);
  if (identity === "/" || /^[a-z]:\/$/i.test(identity)) return identity;
  return identity.replace(/\/+$/, "");
}

/**
 * 决定历史会话目录应保持现状、激活已有终端还是创建新终端。
 * 当前 Space 内的匹配项优先，减少不必要的工作区切换。
 */
export function resolveWorkingDirectoryTarget(
  tabs: readonly Tab[],
  explorerRoot: string | null,
  cwd: string,
  workspace: WorkspaceEnv,
  activeSpaceId: string | null,
  hostWindows?: boolean,
): WorkingDirectoryTarget {
  const target = directoryIdentity(workspace, cwd, hostWindows);
  if (
    explorerRoot &&
    directoryIdentity(workspace, explorerRoot, hostWindows) === target
  ) {
    return { kind: "none" };
  }

  const matches = tabs.filter((tab) => {
    const root =
      tab.kind === "terminal"
        ? tab.cwd
        : tab.kind === "editor" || tab.kind === "markdown"
          ? tab.explorerRoot
          : undefined;
    return (
      root !== undefined &&
      directoryIdentity(workspace, root, hostWindows) === target
    );
  });
  const match =
    matches.find((tab) => tab.spaceId === activeSpaceId) ?? matches[0];
  return match ? { kind: "tab", tabId: match.id } : { kind: "new-terminal" };
}

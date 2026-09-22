/**
 * 本文件从当前进程的 Workbench 状态派生 Agent 可引用的已打开文件。
 * 候选按 Space 分组，并以工作环境中的绝对路径身份去重。
 */

import { documentPathIdentity } from "@/lib/pathIdentity";
import { pathBasename } from "@/lib/utils";
import { isDocumentTab } from "@/modules/editor";
import type { SpaceMeta } from "@/modules/spaces";
import {
  activeTabId,
  DEFAULT_SPACE_ID,
  tabsForSpace,
  type WorkbenchState,
} from "@/modules/workbench";
import type { WorkspaceEnv } from "@/modules/workspace";

export type OpenFileCandidate = {
  path: string;
  name: string;
  active: boolean;
};

export type OpenFileGroup = {
  spaceId: string;
  name: string;
  current: boolean;
  files: OpenFileCandidate[];
};

type BuildOptions = {
  state: WorkbenchState;
  spaces: readonly SpaceMeta[];
  activeSpaceId: string;
  workspace: WorkspaceEnv;
};

/** 当前 Space 优先，Default 非当前时置底；重复路径归入最先出现的 Space。 */
export function buildOpenFileGroups({
  state,
  spaces,
  activeSpaceId,
  workspace,
}: BuildOptions): OpenFileGroup[] {
  const selectedTabId = activeTabId(state, activeSpaceId);
  const current = spaces.find((space) => space.id === activeSpaceId);
  const defaultSpace = spaces.find((space) => space.id === DEFAULT_SPACE_ID);
  const ordered = [
    current,
    ...spaces.filter(
      (space) => space.id !== activeSpaceId && space.id !== DEFAULT_SPACE_ID,
    ),
    activeSpaceId === DEFAULT_SPACE_ID ? undefined : defaultSpace,
  ].filter((space): space is SpaceMeta => space !== undefined);

  const candidatesByPath = new Map<string, OpenFileCandidate>();
  const groups: OpenFileGroup[] = [];
  for (const space of ordered) {
    const files: OpenFileCandidate[] = [];
    for (const tab of tabsForSpace(state, space.id)) {
      if (!isDocumentTab(tab)) continue;
      const identity = documentPathIdentity(workspace, tab.path);
      const existing = candidatesByPath.get(identity);
      if (existing) {
        if (tab.id === selectedTabId) existing.active = true;
        continue;
      }
      const candidate = {
        path: tab.path,
        name: pathBasename(tab.path),
        active: tab.id === selectedTabId,
      };
      candidatesByPath.set(identity, candidate);
      files.push(candidate);
    }
    if (files.length > 0) {
      groups.push({
        spaceId: space.id,
        name: space.name,
        current: space.id === activeSpaceId,
        files,
      });
    }
  }
  return groups;
}

/** 仅按文件名进行不区分大小写的子串过滤，并隐藏空分组。 */
export function filterOpenFileGroups(
  groups: readonly OpenFileGroup[],
  query: string,
): OpenFileGroup[] {
  const normalized = query.toLowerCase();
  if (!normalized) return [...groups];
  return groups.flatMap((group) => {
    const files = group.files.filter((file) =>
      file.name.toLowerCase().includes(normalized),
    );
    return files.length > 0 ? [{ ...group, files }] : [];
  });
}

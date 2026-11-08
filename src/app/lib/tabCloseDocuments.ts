import { documentPathIdentity } from "@/lib/pathIdentity";
import { isDocumentTab } from "@/modules/editor";
import type { Tab } from "@/modules/workbench";
import type { WorkspaceEnv } from "@/modules/workspace";

/** 只检查关闭后失去最后一个视图的文档，按工作区路径身份去重。 */
export function tabCloseDocuments(
  tabs: Tab[],
  isClosing: (tab: Tab) => boolean,
  workspace: WorkspaceEnv,
) {
  const remaining = new Set<string>();
  const removed = new Map<string, { path: string; dirty: boolean }>();

  for (const tab of tabs) {
    if (!isDocumentTab(tab)) continue;
    const identity = documentPathIdentity(workspace, tab.path);
    if (!isClosing(tab)) {
      remaining.add(identity);
      continue;
    }
    const previous = removed.get(identity);
    removed.set(identity, {
      path: previous?.path ?? tab.path,
      dirty: Boolean(previous?.dirty || tab.dirty),
    });
  }

  let dirtyDocuments = 0;
  const discardPaths: string[] = [];
  for (const [identity, document] of removed) {
    if (remaining.has(identity)) continue;
    discardPaths.push(document.path);
    if (document.dirty) dirtyDocuments += 1;
  }
  return { dirtyDocuments, discardPaths };
}

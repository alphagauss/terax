import { documentPathIdentity } from "@/lib/pathIdentity";
import { isDocumentTab } from "@/modules/editor";
import type { Tab } from "@/modules/workbench";
import type { WorkspaceEnv } from "@/modules/workspace";

export type SpaceDeleteDocuments = {
  dirtyDocuments: number;
  discardPaths: string[];
};

export function spaceDeleteDocuments(
  tabs: Tab[],
  spaceId: string,
  workspace: WorkspaceEnv,
): SpaceDeleteDocuments {
  const remaining = new Set(
    tabs
      .filter(isDocumentTab)
      .filter((tab) => tab.spaceId !== spaceId)
      .map((tab) => documentPathIdentity(workspace, tab.path)),
  );
  const removed = new Map<string, { path: string; dirty: boolean }>();

  for (const tab of tabs) {
    if (tab.spaceId !== spaceId || !isDocumentTab(tab)) continue;
    const identity = documentPathIdentity(workspace, tab.path);
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

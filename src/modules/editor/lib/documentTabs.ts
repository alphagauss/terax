import { documentPathIdentity } from "@/lib/pathIdentity";
import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";
import type { EditorTab, MarkdownTab, Tab } from "@/modules/workbench/types";

type DocumentTab = EditorTab | MarkdownTab;

export function isDocumentTab(tab: Tab): tab is DocumentTab {
  return tab.kind === "editor" || tab.kind === "markdown";
}

export function hasOtherDocumentView(
  tabs: Tab[],
  closing: DocumentTab,
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
): boolean {
  const path = documentPathIdentity(workspace, closing.path);
  return tabs.some(
    (candidate) =>
      candidate.id !== closing.id &&
      isDocumentTab(candidate) &&
      documentPathIdentity(workspace, candidate.path) === path,
  );
}

export function countDirtyDocuments(
  tabs: Tab[],
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
): number {
  return new Set(
    tabs
      .filter((tab): tab is DocumentTab => isDocumentTab(tab) && tab.dirty)
      .map((tab) => documentPathIdentity(workspace, tab.path)),
  ).size;
}

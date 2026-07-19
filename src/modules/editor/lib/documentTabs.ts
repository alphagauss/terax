import { normalizePathForIdentity } from "@/lib/utils";
import type { EditorTab, MarkdownTab, Tab } from "@/modules/workbench/types";

type DocumentTab = EditorTab | MarkdownTab;

export function isDocumentTab(tab: Tab): tab is DocumentTab {
  return tab.kind === "editor" || tab.kind === "markdown";
}

export function hasOtherDocumentView(
  tabs: Tab[],
  closing: DocumentTab,
): boolean {
  const path = normalizePathForIdentity(closing.path);
  return tabs.some(
    (candidate) =>
      candidate.id !== closing.id &&
      isDocumentTab(candidate) &&
      normalizePathForIdentity(candidate.path) === path,
  );
}

export function countDirtyDocuments(tabs: Tab[]): number {
  return new Set(
    tabs
      .filter((tab): tab is DocumentTab => isDocumentTab(tab) && tab.dirty)
      .map((tab) => normalizePathForIdentity(tab.path)),
  ).size;
}

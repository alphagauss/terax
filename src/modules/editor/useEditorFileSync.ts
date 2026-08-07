/**
 * 本文件同步已打开编辑器与磁盘写入和文件监听事件。
 *
 * 同一路径的多个视图共享一个文档模型，因此每批事件只触发一次协调读取。
 */

import {
  documentEventResourceKey,
  documentResourceKey,
} from "@/lib/pathIdentity";
import {
  listenFsChanged,
  parentDir,
  watchAdd,
  watchRemove,
} from "@/modules/explorer/lib/watch";
import type { Tab } from "@/modules/workbench";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type RefObject, useEffect, useRef } from "react";
import type { EditorPaneHandle } from "./EditorPane";

type Params = {
  tabs: Tab[];
  tabsRef: RefObject<Tab[]>;
  editorRefs: RefObject<Map<number, EditorPaneHandle>>;
};

/** 对每个共享文档模型至多触发一次重新协调。 */
function reloadMatchingEditors(
  tabs: Tab[],
  editorRefs: RefObject<Map<number, EditorPaneHandle>>,
  changed: Set<string>,
  mode: "probe" | "reload",
): void {
  const workspace = currentWorkspaceEnv();
  const reloaded = new Set<string>();
  for (const tab of tabs) {
    if (tab.kind !== "editor" && tab.kind !== "markdown") continue;
    const key = documentResourceKey(workspace, tab.path);
    if (!changed.has(key) || reloaded.has(key)) continue;
    const editor = editorRefs.current.get(tab.id);
    if (!editor) continue;
    reloaded.add(key);
    if (mode === "probe") editor.checkForChanges();
    else editor.reload();
  }
}

/**
 * 维护编辑器文件监听，并在 AI 修改、外部写入或文件事件后协调磁盘内容。
 */
export function useEditorFileSync({ tabs, tabsRef, editorRefs }: Params) {
  useEffect(() => {
    type FileWrittenPayload = { path: string; source?: string };
    const unlistenPromise =
      getCurrentWebviewWindow().listen<FileWrittenPayload>(
        "fs:file-written",
        (event) => {
          if (event.payload.source === "editor") return;
          const workspace = currentWorkspaceEnv();
          reloadMatchingEditors(
            tabsRef.current,
            editorRefs,
            new Set([documentEventResourceKey(workspace, event.payload.path)]),
            "reload",
          );
        },
      );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, [tabsRef, editorRefs]);

  const editorWatchRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const want = new Set<string>();
    for (const t of tabs) {
      if (t.kind === "editor" || t.kind === "markdown") {
        want.add(parentDir(t.path));
      }
    }
    const prev = editorWatchRef.current;
    const toAdd = [...want].filter((d) => !prev.has(d));
    const toRemove = [...prev].filter((d) => !want.has(d));
    watchAdd(toAdd);
    watchRemove(toRemove);
    editorWatchRef.current = want;
  }, [tabs]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listenFsChanged((paths) => {
      const workspace = currentWorkspaceEnv();
      const changed = new Set(
        paths.map((path) => documentEventResourceKey(workspace, path)),
      );
      reloadMatchingEditors(tabsRef.current, editorRefs, changed, "probe");
    }).then((un) => {
      if (alive) unlisten = un;
      else un();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [tabsRef, editorRefs]);
}

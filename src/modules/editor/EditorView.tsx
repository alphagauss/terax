/**
 * 本文件实现已加载的代码编辑器视图。
 *
 * 文档由轻量外壳提前读取，本组件只负责连接标签页动作与 CodeMirror 面板。
 */

import type { EditorTab } from "@/modules/workbench";
import { useCallback } from "react";
import { EditorCore, type EditorPaneHandle } from "./EditorPane";
import type { EditorDocument } from "./lib/useDocument";

type Props = {
  tab: EditorTab;
  document: EditorDocument;
  focused: boolean;
  registerHandle: (id: number, handle: EditorPaneHandle | null) => void;
  onCloseTab: (id: number) => void;
};

/**
 * 已加载的代码编辑器视图。
 *
 * 保持标签页句柄稳定，并使用外壳提供的共享文档创建 CodeMirror。
 */
export function EditorView({
  tab,
  document,
  focused,
  registerHandle,
  onCloseTab,
}: Props) {
  const handleRef = useCallback(
    (handle: EditorPaneHandle | null) => registerHandle(tab.id, handle),
    [registerHandle, tab.id],
  );
  const handleClose = useCallback(
    () => onCloseTab(tab.id),
    [onCloseTab, tab.id],
  );

  return (
    <div className="relative h-full overflow-hidden rounded-md bg-background">
      <EditorCore
        ref={handleRef}
        path={tab.path}
        document={document}
        lspEnabled={focused}
        onClose={handleClose}
      />
    </div>
  );
}

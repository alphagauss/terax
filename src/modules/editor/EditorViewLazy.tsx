/**
 * 本文件实现代码编辑器的渐进加载外壳。
 *
 * 文件读取与 CodeMirror 模块并行进行，运行时就绪后直接进入纯文本编辑器。
 */

import type { EditorTab } from "@/modules/workbench";
import { lazy, Suspense, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { EditorPaneHandle } from "./EditorPane";
import { useDocument } from "./lib/useDocument";

const EditorViewInner = lazy(() =>
  import("./EditorView").then((module) => ({ default: module.EditorView })),
);

type Props = {
  tab: EditorTab;
  visible: boolean;
  focused: boolean;
  onDirtyChange: (id: number, dirty: boolean) => void;
  registerHandle: (id: number, handle: EditorPaneHandle | null) => void;
  onCloseTab: (id: number) => void;
};

/**
 * 代码编辑器渐进加载视图。
 *
 * 立即订阅共享文档，使文件读取与 CodeMirror 加载并行完成。
 */
export function EditorView({
  tab,
  visible,
  focused,
  onDirtyChange,
  registerHandle,
  onCloseTab,
}: Props) {
  const { t } = useTranslation("common");
  const handleDirtyChange = useCallback(
    (dirty: boolean) => onDirtyChange(tab.id, dirty),
    [onDirtyChange, tab.id],
  );
  const document = useDocument({
    path: tab.path,
    active: visible,
    onDirtyChange: handleDirtyChange,
  });

  return (
    <Suspense
      fallback={
        <div className="grid h-full place-items-center text-xs text-muted-foreground">
          {t("loading")}
        </div>
      }
    >
      <EditorViewInner
        tab={tab}
        document={document}
        focused={focused}
        registerHandle={registerHandle}
        onCloseTab={onCloseTab}
      />
    </Suspense>
  );
}

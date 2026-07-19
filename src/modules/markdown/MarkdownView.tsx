import type { EditorPaneHandle } from "@/modules/editor/EditorPane";
import type { MarkdownTab } from "@/modules/workbench";
import {
  MarkdownPreviewPane,
  type MarkdownPreviewPaneHandle,
} from "./MarkdownPreviewPane";

type Props = {
  tab: MarkdownTab;
  visible: boolean;
  focused: boolean;
  registerEditorHandle: (id: number, handle: EditorPaneHandle | null) => void;
  registerNavigationHandle: (
    id: number,
    handle: MarkdownPreviewPaneHandle | null,
  ) => void;
  onDirtyChange: (id: number, dirty: boolean) => void;
  onCloseTab: (id: number) => void;
};

export function MarkdownView({
  tab,
  visible,
  focused,
  registerEditorHandle,
  registerNavigationHandle,
  onDirtyChange,
  onCloseTab,
}: Props) {
  return (
    <MarkdownPreviewPane
      id={tab.id}
      path={tab.path}
      visible={visible}
      focused={focused}
      registerEditorHandle={registerEditorHandle}
      registerNavigationHandle={registerNavigationHandle}
      onDirtyChange={onDirtyChange}
      onCloseTab={onCloseTab}
    />
  );
}

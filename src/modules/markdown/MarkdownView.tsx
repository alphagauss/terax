import type { EditorPaneHandle } from "@/modules/editor/EditorPane";
import type { FindHandle } from "@/modules/find";
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
  registerFindHandle: (id: number, handle: FindHandle | null) => void;
  onFileReferenceOpen: (path: string, line?: number) => void | Promise<void>;
  onFileReferenceOpenDirectory: (path: string) => void | Promise<void>;
  onDirtyChange: (id: number, dirty: boolean) => void;
  onCloseTab: (id: number) => void;
};

export function MarkdownView({
  tab,
  visible,
  focused,
  registerEditorHandle,
  registerNavigationHandle,
  registerFindHandle,
  onFileReferenceOpen,
  onFileReferenceOpenDirectory,
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
      registerFindHandle={registerFindHandle}
      onFileReferenceOpen={onFileReferenceOpen}
      onFileReferenceOpenDirectory={onFileReferenceOpenDirectory}
      onDirtyChange={onDirtyChange}
      onCloseTab={onCloseTab}
    />
  );
}

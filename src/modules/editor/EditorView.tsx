import type { EditorTab } from "@/modules/workbench";
import { useCallback } from "react";
import { EditorPane, type EditorPaneHandle } from "./EditorPane";

type Props = {
  tab: EditorTab;
  focused: boolean;
  onDirtyChange: (id: number, dirty: boolean) => void;
  registerHandle: (id: number, handle: EditorPaneHandle | null) => void;
  onCloseTab: (id: number) => void;
};

export function EditorView({
  tab,
  focused,
  onDirtyChange,
  registerHandle,
  onCloseTab,
}: Props) {
  const handleRef = useCallback(
    (handle: EditorPaneHandle | null) => registerHandle(tab.id, handle),
    [registerHandle, tab.id],
  );
  const handleDirtyChange = useCallback(
    (dirty: boolean) => onDirtyChange(tab.id, dirty),
    [onDirtyChange, tab.id],
  );
  const handleClose = useCallback(
    () => onCloseTab(tab.id),
    [onCloseTab, tab.id],
  );

  return (
    <div className="relative h-full overflow-hidden rounded-md bg-background">
      <EditorPane
        ref={handleRef}
        path={tab.path}
        lspEnabled={focused}
        overrideLanguage={tab.overrideLanguage}
        onDirtyChange={handleDirtyChange}
        onClose={handleClose}
      />
    </div>
  );
}

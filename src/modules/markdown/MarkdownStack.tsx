import { cn } from "@/lib/utils";
import type { EditorPaneHandle } from "@/modules/editor/EditorPane";
import {
  MarkdownPreviewPane,
  type MarkdownPreviewPaneHandle,
} from "@/modules/markdown/MarkdownPreviewPane";
import type { MarkdownTab, Tab } from "@/modules/tabs";

type Props = {
  tabs: Tab[];
  activeId: number;
  registerEditorHandle: (id: number, handle: EditorPaneHandle | null) => void;
  registerNavigationHandle: (
    id: number,
    handle: MarkdownPreviewPaneHandle | null,
  ) => void;
  onDirtyChange: (id: number, dirty: boolean) => void;
  onCloseTab: (id: number) => void;
};

export function MarkdownStack({
  tabs,
  activeId,
  registerEditorHandle,
  registerNavigationHandle,
  onDirtyChange,
  onCloseTab,
}: Props) {
  const markdowns = tabs.filter(
    (t): t is MarkdownTab => t.kind === "markdown" && !t.cold,
  );
  if (markdowns.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {markdowns.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible}
          >
            <MarkdownPreviewPane
              id={t.id}
              path={t.path}
              visible={visible}
              dirty={t.dirty}
              registerEditorHandle={registerEditorHandle}
              registerNavigationHandle={registerNavigationHandle}
              onDirtyChange={onDirtyChange}
              onCloseTab={onCloseTab}
            />
          </div>
        );
      })}
    </div>
  );
}

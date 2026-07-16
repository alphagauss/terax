import type {
  EditorPaneHandle,
  EditorPaneProps,
} from "@/modules/editor/EditorPane";
import { forwardRef, lazy, Suspense } from "react";

const EditorPane = lazy(() =>
  import("@/modules/editor/EditorPane").then((module) => ({
    default: module.EditorPane,
  })),
);

export const MarkdownRawPane = forwardRef<EditorPaneHandle, EditorPaneProps>(
  function MarkdownRawPane(props, ref) {
    return (
      <Suspense fallback={null}>
        <EditorPane {...props} ref={ref} />
      </Suspense>
    );
  },
);

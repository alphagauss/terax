import { type ComponentProps, lazy, Suspense } from "react";
import type { EditorView as EditorViewType } from "./EditorView";

const EditorViewInner = lazy(() =>
  import("./EditorView").then((module) => ({ default: module.EditorView })),
);

type Props = ComponentProps<typeof EditorViewType>;

export function EditorView(props: Props) {
  return (
    <Suspense fallback={null}>
      <EditorViewInner {...props} />
    </Suspense>
  );
}

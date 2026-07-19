import { type ComponentProps, lazy, Suspense } from "react";
import type { MarkdownView as MarkdownViewType } from "./MarkdownView";

const MarkdownViewInner = lazy(() =>
  import("./MarkdownView").then((module) => ({ default: module.MarkdownView })),
);

type Props = ComponentProps<typeof MarkdownViewType>;

export function MarkdownView(props: Props) {
  return (
    <Suspense fallback={null}>
      <MarkdownViewInner {...props} />
    </Suspense>
  );
}

import { type ComponentProps, lazy, Suspense } from "react";
import type { GitDiffView as GitDiffViewType } from "./GitDiffView";

const GitDiffViewInner = lazy(() =>
  import("./GitDiffView").then((module) => ({ default: module.GitDiffView })),
);

type Props = ComponentProps<typeof GitDiffViewType>;

export function GitDiffView(props: Props) {
  return (
    <Suspense fallback={null}>
      <GitDiffViewInner {...props} />
    </Suspense>
  );
}

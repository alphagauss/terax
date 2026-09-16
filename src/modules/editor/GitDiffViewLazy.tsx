import type { FindHandle } from "@/modules/find";
import { type ComponentProps, forwardRef, lazy, Suspense } from "react";
import type { GitDiffView as GitDiffViewType } from "./GitDiffView";

const GitDiffViewInner = lazy(() =>
  import("./GitDiffView").then((module) => ({ default: module.GitDiffView })),
);

type Props = ComponentProps<typeof GitDiffViewType>;

export const GitDiffView = forwardRef<FindHandle, Props>(
  function GitDiffView(props, ref) {
    return (
      <Suspense fallback={null}>
        <GitDiffViewInner {...props} ref={ref} />
      </Suspense>
    );
  },
);

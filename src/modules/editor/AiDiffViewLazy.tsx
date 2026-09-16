import type { FindHandle } from "@/modules/find";
import { type ComponentProps, forwardRef, lazy, Suspense } from "react";
import type { AiDiffView as AiDiffViewType } from "./AiDiffView";

const AiDiffViewInner = lazy(() =>
  import("./AiDiffView").then((module) => ({ default: module.AiDiffView })),
);

type Props = ComponentProps<typeof AiDiffViewType>;

export const AiDiffView = forwardRef<FindHandle, Props>(
  function AiDiffView(props, ref) {
    return (
      <Suspense fallback={null}>
        <AiDiffViewInner {...props} ref={ref} />
      </Suspense>
    );
  },
);

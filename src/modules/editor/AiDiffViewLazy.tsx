import { type ComponentProps, lazy, Suspense } from "react";
import type { AiDiffView as AiDiffViewType } from "./AiDiffView";

const AiDiffViewInner = lazy(() =>
  import("./AiDiffView").then((module) => ({ default: module.AiDiffView })),
);

type Props = ComponentProps<typeof AiDiffViewType>;

export function AiDiffView(props: Props) {
  return (
    <Suspense fallback={null}>
      <AiDiffViewInner {...props} />
    </Suspense>
  );
}

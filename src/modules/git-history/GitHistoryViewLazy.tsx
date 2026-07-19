import { type ComponentProps, lazy, Suspense } from "react";
import type { GitHistoryView as GitHistoryViewType } from "./GitHistoryView";

const GitHistoryViewInner = lazy(() =>
  import("./GitHistoryView").then((module) => ({
    default: module.GitHistoryView,
  })),
);

type Props = ComponentProps<typeof GitHistoryViewType>;

export function GitHistoryView(props: Props) {
  return (
    <Suspense fallback={null}>
      <GitHistoryViewInner {...props} />
    </Suspense>
  );
}

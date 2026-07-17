import { lazy, Suspense } from "react";
import type { ComponentProps } from "react";
import type { SourceControlViewContainer as SourceControlViewContainerType } from "./SourceControlPanel";

const SourceControlViewContainerInner = lazy(() =>
  import("./SourceControlPanel").then((m) => ({
    default: m.SourceControlViewContainer,
  })),
);

type Props = ComponentProps<typeof SourceControlViewContainerType>;

export function SourceControlViewContainer(props: Props) {
  return (
    <Suspense fallback={null}>
      <SourceControlViewContainerInner {...props} />
    </Suspense>
  );
}

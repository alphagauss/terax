import { lazy, Suspense, type ComponentProps } from "react";
import type { ReadonlyDiff as Diff } from "@/modules/editor/ReadonlyDiff";

const Inner = lazy(() =>
  import("@/modules/editor/ReadonlyDiff").then((module) => ({
    default: module.ReadonlyDiff,
  })),
);

export function ReadonlyDiff(props: ComponentProps<typeof Diff>) {
  return (
    <Suspense fallback={null}>
      <Inner {...props} />
    </Suspense>
  );
}

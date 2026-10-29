import { useDiagnosticsStore } from "@/modules/editor";
import Alert02Icon from "@hugeicons/core-free-icons/Alert02Icon";
import CancelCircleIcon from "@hugeicons/core-free-icons/CancelCircleIcon";
import { HugeiconsIcon } from "@hugeicons/react";

type Props = {
  filePath: string | null;
};

/** 展示当前文件的错误与警告数量。 */
export function DiagnosticsBadge({ filePath }: Props) {
  const counts = useDiagnosticsStore((s) =>
    filePath ? s.byPath[filePath] : undefined,
  );
  if (!counts || (counts.errors === 0 && counts.warnings === 0)) return null;

  return (
    <span className="terax-pill-in flex shrink-0 cursor-default items-center gap-2 font-medium tabular-nums">
      {counts.errors > 0 ? (
        <span className="flex items-center gap-1 text-destructive">
          <HugeiconsIcon icon={CancelCircleIcon} strokeWidth={2} />
          {counts.errors}
        </span>
      ) : null}
      {counts.warnings > 0 ? (
        <span className="flex items-center gap-1 text-warning">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} />
          {counts.warnings}
        </span>
      ) : null}
    </span>
  );
}
/**
 * 本文件渲染状态栏诊断计数。
 * 错误复用 destructive，警告使用主题 warning 语义色。
 */

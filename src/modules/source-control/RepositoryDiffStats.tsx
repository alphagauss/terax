/** 面板内存态的统计范围切换；刷新保留选择，仓库切换由宿主重置。 */
import { AnimatedDiffStats } from "@/components/controls/animated-diff-stats";
import { Button } from "@/components/controls/button";
import { Hint } from "@/components/controls/tooltip";
import type { GitPanelDiffStats } from "@/modules/ai/lib/native";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function RepositoryDiffStats({
  stats,
}: {
  stats: GitPanelDiffStats | null;
}) {
  const { t } = useTranslation("sourceControl");
  const [staged, setStaged] = useState(false);
  const value = staged ? stats?.index : stats?.worktree;
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      <Hint
        content={t(staged ? "lineStats.showModified" : "lineStats.showStaged")}
      >
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          aria-pressed={staged}
          onClick={() => setStaged(!staged)}
        >
          {t(staged ? "lineStats.staged" : "lineStats.modified")}
        </Button>
      </Hint>
      <Hint
        content={t(
          !value
            ? "lineStats.unavailable"
            : value.incomplete
              ? "lineStats.incomplete"
              : "lineStats.description",
        )}
      >
        <span className="relative inline-flex w-[calc(10ch+0.125rem)] shrink-0 items-center justify-end font-mono text-xs [&>span]:gap-0.5 [&_.file-edit-number]:w-[5ch] [&_.file-edit-number]:text-right [&_.file-edit-number>span]:w-full [&_.file-edit-number-old]:right-0">
          {value ? (
            <>
              <AnimatedDiffStats
                stats={{
                  added: Math.min(value.added, 9999),
                  removed: Math.min(value.removed, 9999),
                }}
              />
              {value.incomplete && (
                <span className="absolute -right-1.5 text-xs text-muted-foreground">
                  <span aria-hidden>*</span>
                  <span className="sr-only">{t("lineStats.incomplete")}</span>
                </span>
              )}
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              {t("lineStats.unavailable")}
            </span>
          )}
        </span>
      </Hint>
    </div>
  );
}

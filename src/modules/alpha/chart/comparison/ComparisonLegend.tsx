/**
 * 本文件渲染对比标的相对收益 legend 与局部恢复操作。
 * Legend 只消费统一十字线快照或最新值，不订阅图表，也不触发行情查询。
 */

import { Button } from "@/components/controls/button";
import type {
  ChartComparisonLegendValues,
  ChartComparisonState,
} from "@/modules/alpha/chart/model";
import {
  Delete02Icon,
  RefreshIcon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  mainSymbol: string | null;
  mainName: string | null;
  comparisons: readonly ChartComparisonState[];
  values: ChartComparisonLegendValues;
  onManage: () => void;
  onRemove: (vtSymbol: string) => void;
  onRetry: (vtSymbol: string) => void;
};

/** 展示共同基准下的主标的、对比标的精确时点值和各自状态。 */
export function ComparisonLegend({
  mainSymbol,
  mainName,
  comparisons,
  values,
  onManage,
  onRemove,
  onRetry,
}: Props) {
  const { t, i18n } = useTranslation("alpha");
  const number = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    [i18n.language],
  );
  if (comparisons.length === 0) return null;
  const formatValue = (value: number | null | undefined) =>
    value === null || value === undefined
      ? "-"
      : `${value > 0 ? "+" : ""}${number.format(value)}%`;

  return (
    <div
      className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-3 py-1 font-mono text-[10px]"
      data-alpha-comparison-legend="true"
    >
      {mainSymbol ? (
        <div className="flex min-w-0 items-center gap-1.5 text-chart-1">
          <span
            className="max-w-36 truncate font-medium"
            title={
              mainName && mainName !== mainSymbol
                ? `${mainName} ${mainSymbol}`
                : mainSymbol
            }
          >
            {mainName && mainName !== mainSymbol
              ? `${mainName} ${mainSymbol}`
              : mainSymbol}
          </span>
          <span>{formatValue(values[mainSymbol])}</span>
        </div>
      ) : null}
      {comparisons.map((comparison) => (
        <div
          key={comparison.vtSymbol}
          className="flex min-w-0 items-center gap-1"
          data-alpha-comparison={comparison.vtSymbol}
          data-status={comparison.status}
        >
          <button
            type="button"
            className="max-w-36 truncate font-medium hover:underline"
            style={{ color: comparison.color }}
            title={`${comparison.name} ${comparison.vtSymbol}`}
            onClick={onManage}
          >
            {comparison.name === comparison.vtSymbol
              ? comparison.vtSymbol
              : `${comparison.name} ${comparison.vtSymbol}`}
          </button>
          <span style={{ color: comparison.color }}>
            {comparison.status === "ready"
              ? formatValue(values[comparison.vtSymbol])
              : t(`data.chart.comparisons.status.${comparison.status}`)}
          </span>
          {comparison.partial ? (
            <span className="text-muted-foreground">
              {t("data.chart.comparisons.status.partial")}
            </span>
          ) : null}
          {comparison.status === "error" ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title={t("data.chart.comparisons.actions.retry")}
              aria-label={t("data.chart.comparisons.actions.retry")}
              onClick={() => onRetry(comparison.vtSymbol)}
            >
              <HugeiconsIcon icon={RefreshIcon} size={11} strokeWidth={1.8} />
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            title={t("data.chart.comparisons.actions.manage")}
            aria-label={t("data.chart.comparisons.actions.manage")}
            onClick={onManage}
          >
            <HugeiconsIcon icon={Settings02Icon} size={11} strokeWidth={1.8} />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="text-destructive"
            title={t("data.chart.comparisons.actions.remove")}
            aria-label={t("data.chart.comparisons.actions.remove")}
            onClick={() => onRemove(comparison.vtSymbol)}
          >
            <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.8} />
          </Button>
        </div>
      ))}
    </div>
  );
}

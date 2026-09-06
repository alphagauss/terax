/**
 * 本文件渲染工作台图表的指标 legend 与紧凑管理操作。
 * Legend 只消费统一十字线快照或最新值，不订阅图表也不执行计算。
 */

import { Button } from "@/components/controls/button";
import type { ChartStudyLegendValues } from "@/modules/alpha/chart/controller/FinancialChartController";
import type { ChartStudyInstance } from "@/modules/alpha/chart/studies/model";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Delete02Icon,
  Settings02Icon,
  ViewIcon,
  ViewOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  instances: readonly ChartStudyInstance[];
  values: ChartStudyLegendValues;
  loading: boolean;
  error: boolean;
  onToggle: (instanceId: string) => void;
  onEdit: (instanceId: string) => void;
  onRemove: (instanceId: string) => void;
  onMove: (instanceId: string, direction: -1 | 1) => void;
};

/** 渲染所有持久化指标实例及其当前值和管理动作。 */
export function StudyLegend({
  instances,
  values,
  loading,
  error,
  onToggle,
  onEdit,
  onRemove,
  onMove,
}: Props) {
  const { t, i18n } = useTranslation("alpha");
  const number = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        maximumFractionDigits: 4,
      }),
    [i18n.language],
  );
  if (instances.length === 0) return null;

  return (
    <div
      className="flex max-h-16 flex-wrap items-center gap-x-3 gap-y-1 overflow-y-auto border-b border-border/40 px-3 py-1 font-mono text-[10px]"
      data-alpha-study-legend="true"
    >
      {instances.map((instance, index) => (
        <div
          key={instance.instanceId}
          className="flex min-w-0 items-center gap-1.5"
          data-alpha-study-instance={instance.instanceId}
          data-visible={instance.visible}
        >
          <button
            type="button"
            className="max-w-36 truncate font-medium hover:underline"
            style={{
              color: Object.values(instance.styles)[0]?.color ?? "currentColor",
              opacity: instance.visible ? 1 : 0.55,
            }}
            title={t("data.chart.studies.actions.edit")}
            onClick={() => onEdit(instance.instanceId)}
          >
            {t(`data.chart.studies.types.${instance.type}`)}(
            {Object.values(instance.params).join(",")})
          </button>
          {instance.visible
            ? Object.entries(values[instance.instanceId] ?? {}).map(
                ([outputId, value]) => (
                  <span
                    key={outputId}
                    style={{ color: instance.styles[outputId]?.color }}
                    title={t(
                      `data.chart.studies.outputs.${instance.type}.${outputId}`,
                    )}
                  >
                    {value === null ? "-" : number.format(value)}
                  </span>
                ),
              )
            : null}
          <div className="flex items-center">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title={t(
                instance.visible
                  ? "data.chart.studies.actions.hide"
                  : "data.chart.studies.actions.show",
              )}
              aria-label={t(
                instance.visible
                  ? "data.chart.studies.actions.hide"
                  : "data.chart.studies.actions.show",
              )}
              onClick={() => onToggle(instance.instanceId)}
            >
              <HugeiconsIcon
                icon={instance.visible ? ViewIcon : ViewOffIcon}
                size={11}
                strokeWidth={1.8}
              />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title={t("data.chart.studies.actions.edit")}
              aria-label={t("data.chart.studies.actions.edit")}
              onClick={() => onEdit(instance.instanceId)}
            >
              <HugeiconsIcon
                icon={Settings02Icon}
                size={11}
                strokeWidth={1.8}
              />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              disabled={index === 0}
              title={t("data.chart.studies.actions.moveUp")}
              aria-label={t("data.chart.studies.actions.moveUp")}
              onClick={() => onMove(instance.instanceId, -1)}
            >
              <HugeiconsIcon icon={ArrowUp01Icon} size={11} strokeWidth={1.8} />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              disabled={index === instances.length - 1}
              title={t("data.chart.studies.actions.moveDown")}
              aria-label={t("data.chart.studies.actions.moveDown")}
              onClick={() => onMove(instance.instanceId, 1)}
            >
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={11}
                strokeWidth={1.8}
              />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="text-destructive"
              title={t("data.chart.studies.actions.remove")}
              aria-label={t("data.chart.studies.actions.remove")}
              onClick={() => onRemove(instance.instanceId)}
            >
              <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.8} />
            </Button>
          </div>
        </div>
      ))}
      {loading ? (
        <span className="text-muted-foreground">
          {t("data.chart.studies.status.loading")}
        </span>
      ) : null}
      {error ? (
        <span className="text-destructive">
          {t("data.chart.studies.status.error")}
        </span>
      ) : null}
    </div>
  );
}

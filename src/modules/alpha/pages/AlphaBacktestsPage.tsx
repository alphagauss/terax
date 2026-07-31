/**
 * 本文件实现 Alpha 回测结果页面。
 * 页面连接回测列表、净值和回撤接口，不在前端重新计算回测指标。
 */

import { Button } from "@/components/ui/button";
import { getAlphaBacktests, getAlphaBacktestSeries } from "@/modules/alpha/api";
import { AlphaBacktestTable } from "@/modules/alpha/components/AlphaBacktestTable";
import {
  AlphaEChart,
  type AlphaChartPalette,
} from "@/modules/alpha/components/AlphaEChart";
import {
  AlphaEmptyText,
  AlphaLoading,
  AlphaMetric,
  AlphaSectionTitle,
} from "@/modules/alpha/components/AlphaPagePrimitives";
import { AlphaQueryProvider } from "@/modules/alpha/query";
import { useQuery } from "@tanstack/react-query";
import type { EChartsCoreOption } from "echarts/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  visible: boolean;
};

/** 为回测页接入 Alpha 共享查询缓存。 */
export function AlphaBacktestsPage(props: Props) {
  return (
    <AlphaQueryProvider>
      <AlphaBacktestsPageContent {...props} />
    </AlphaQueryProvider>
  );
}

/** 连接回测 API 并渲染结果表格和曲线。 */
function AlphaBacktestsPageContent({ visible }: Props) {
  const { t, i18n } = useTranslation("alpha");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const backtests = useQuery({
    queryKey: ["alpha", "backtests", 50],
    queryFn: () => getAlphaBacktests(50),
    enabled: visible,
    refetchInterval: visible ? 5_000 : false,
  });
  const selected = backtests.data?.items.find((item) => item.id === selectedId);
  const series = useQuery({
    queryKey: ["alpha", "backtest-series", selectedId],
    queryFn: () => getAlphaBacktestSeries(selectedId ?? ""),
    enabled: visible && selectedId !== null && selected?.status === "completed",
  });

  useEffect(() => {
    if (!backtests.data) return;
    if (
      selectedId &&
      backtests.data.items.some((item) => item.id === selectedId)
    ) {
      return;
    }
    const completed = backtests.data.items.find(
      (item) => item.status === "completed",
    );
    setSelectedId(completed?.id ?? backtests.data.items[0]?.id ?? null);
  }, [backtests.data, selectedId]);

  const percent = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        style: "percent",
        maximumFractionDigits: 2,
      }),
    [i18n.language],
  );
  const number = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        maximumFractionDigits: 2,
      }),
    [i18n.language],
  );
  const createSeriesOption = useCallback(
    (palette: AlphaChartPalette): EChartsCoreOption => {
      const equity = series.data?.equity ?? [];
      const drawdownByDate = new Map(
        (series.data?.drawdown ?? []).map((item) => [item.date, item.drawdown]),
      );
      return {
        animationDuration: 160,
        color: [palette.colors[1], "#ef4444"],
        grid: { left: 62, right: 62, top: 34, bottom: 34 },
        legend: {
          top: 0,
          textStyle: { color: palette.muted },
        },
        tooltip: { trigger: "axis" },
        xAxis: {
          type: "category",
          data: equity.map((item) => item.date),
          axisLine: { lineStyle: { color: palette.border } },
          axisLabel: { color: palette.muted },
        },
        yAxis: [
          {
            type: "value",
            axisLabel: { color: palette.muted },
            splitLine: { lineStyle: { color: palette.border } },
          },
          {
            type: "value",
            axisLabel: {
              color: palette.muted,
              formatter: (value: number) => percent.format(value),
            },
            splitLine: { show: false },
          },
        ],
        series: [
          {
            type: "line",
            name: t("backtests.chart.equity"),
            data: equity.map((item) => item.equity),
            showSymbol: false,
            smooth: false,
          },
          {
            type: "line",
            name: t("backtests.chart.drawdown"),
            yAxisIndex: 1,
            data: equity.map((item) => drawdownByDate.get(item.date) ?? null),
            showSymbol: false,
            areaStyle: { opacity: 0.08 },
          },
        ],
      };
    },
    [percent, series.data, t],
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-5">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-base font-semibold">{t("backtests.title")}</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("backtests.description")}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void backtests.refetch()}
          >
            {t("common.refresh")}
          </Button>
        </header>

        {backtests.error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs text-destructive">
            {String(backtests.error)}
          </div>
        ) : null}

        <section className="rounded-xl border border-border/70 bg-card p-4">
          <AlphaSectionTitle
            title={t("backtests.list.title")}
            description={t("backtests.list.description", {
              count: backtests.data?.total ?? 0,
            })}
          />
          <div className="mt-3">
            {backtests.isPending ? (
              <div className="h-64">
                <AlphaLoading label={t("common.loading")} />
              </div>
            ) : backtests.data?.items.length ? (
              <AlphaBacktestTable
                rows={backtests.data.items}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            ) : (
              <div className="h-64">
                <AlphaEmptyText>{t("backtests.list.empty")}</AlphaEmptyText>
              </div>
            )}
          </div>
        </section>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <AlphaMetric
            label={t("backtests.metrics.return")}
            value={formatMetric(selected?.total_return, percent, t)}
          />
          <AlphaMetric
            label={t("backtests.metrics.drawdown")}
            value={formatMetric(selected?.max_drawdown, percent, t)}
          />
          <AlphaMetric
            label={t("backtests.metrics.sharpe")}
            value={formatMetric(selected?.sharpe, number, t)}
          />
          <AlphaMetric
            label={t("backtests.metrics.trades")}
            value={formatMetric(selected?.trade_count, number, t)}
          />
        </div>

        <section className="rounded-xl border border-border/70 bg-card p-4">
          <AlphaSectionTitle
            title={selected?.name ?? t("backtests.chart.title")}
            description={t("backtests.chart.description")}
          />
          <div className="mt-3 h-96">
            {selected?.status !== "completed" ? (
              <AlphaEmptyText>{t("backtests.chart.pending")}</AlphaEmptyText>
            ) : series.isPending ? (
              <AlphaLoading label={t("common.loading")} />
            ) : series.error ? (
              <AlphaEmptyText>{String(series.error)}</AlphaEmptyText>
            ) : series.data?.equity.length ? (
              <AlphaEChart
                visible={visible}
                ariaLabel={t("backtests.chart.aria", {
                  name: selected.name,
                })}
                createOption={createSeriesOption}
              />
            ) : (
              <AlphaEmptyText>{t("backtests.chart.empty")}</AlphaEmptyText>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/** 使用指定数字格式器展示可选回测指标。 */
function formatMetric(
  value: number | null | undefined,
  formatter: Intl.NumberFormat,
  t: (key: string) => string,
): string {
  return value == null ? t("common.unavailable") : formatter.format(value);
}

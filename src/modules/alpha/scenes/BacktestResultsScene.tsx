/**
 * 本文件提供可被独立页面和三栏实验页共同使用的回测结果场景。
 * 页面连接回测列表、统一任务事件、净值和回撤接口，不在前端重新计算回测指标。
 */

import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/controls/button";
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
import {
  subscribeAlphaEventConnection,
  subscribeAlphaTasks,
  taskDisplayStatus,
} from "@/modules/alpha/events/tasks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EChartsCoreOption } from "echarts/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  visible: boolean;
};

const BACKTEST_QUERY_KEY = ["alpha", "backtests", 50] as const;

/** 连接回测 API 并渲染结果表格和曲线。 */
export function BacktestResultsScene({ visible }: Props) {
  const { t, i18n } = useTranslation("alpha");
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const backtests = useQuery({
    queryKey: BACKTEST_QUERY_KEY,
    queryFn: () => getAlphaBacktests(50),
    enabled: visible,
  });
  const selected = backtests.data?.items.find((item) => item.id === selectedId);
  const series = useQuery({
    queryKey: ["alpha", "backtest-series", selectedId],
    queryFn: () => getAlphaBacktestSeries(selectedId ?? ""),
    enabled: visible && selectedId !== null && selected?.status === "completed",
  });
  useEffect(() => {
    if (!visible) return;
    const releaseTasks = subscribeAlphaTasks((task) => {
      if (task.kind !== "backtest") return;
      let found = false;
      queryClient.setQueryData<Awaited<ReturnType<typeof getAlphaBacktests>>>(
        BACKTEST_QUERY_KEY,
        (current) => {
          if (!current) return current;
          const items = current.items.map((item) => {
            if (item.id !== task.id) return item;
            found = true;
            if (item.revision > task.revision) return item;
            return {
              ...item,
              status: taskDisplayStatus(task.status),
              stage: task.stage,
              progress: task.progress,
              metrics: task.metrics,
              revision: task.revision,
            };
          });
          return { ...current, items };
        },
      );
      if (!found || task.status !== "running") {
        void queryClient.invalidateQueries({ queryKey: BACKTEST_QUERY_KEY });
      }
    });
    const releaseConnection = subscribeAlphaEventConnection((connected) => {
      if (connected) {
        void queryClient.invalidateQueries({ queryKey: BACKTEST_QUERY_KEY });
      }
    });
    return () => {
      releaseTasks();
      releaseConnection();
    };
  }, [queryClient, visible]);

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
    <div className="app-scrollbar h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-section p-4 sm:p-page">
        <PageHeader
          title={t("backtests.title")}
          description={t("backtests.description")}
          actions={
            <Button variant="outline" onClick={() => void backtests.refetch()}>
              {t("common.refresh")}
            </Button>
          }
        />

        {backtests.error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs text-destructive">
            {String(backtests.error)}
          </div>
        ) : null}

        <section className="rounded-lg border border-border/60 bg-card p-3">
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

        <section className="rounded-lg border border-border/60 bg-card p-3">
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

/**
 * 本文件实现 Alpha 数据管理页面。
 * 页面连接服务状态、数据覆盖、证券列表和日 K 线接口，作为后续数据功能的精简基础。
 */

import { Button } from "@/components/ui/button";
import {
  getAlphaBars,
  getAlphaDataOverview,
  getAlphaOverview,
  getAlphaSecurities,
} from "@/modules/alpha/api";
import {
  AlphaEChart,
  type AlphaChartPalette,
} from "@/modules/alpha/components/AlphaEChart";
import { AlphaFinancialChart } from "@/modules/alpha/components/AlphaFinancialChart";
import {
  AlphaEmptyText,
  AlphaLoading,
  AlphaMetric,
  AlphaSectionTitle,
} from "@/modules/alpha/components/AlphaPagePrimitives";
import { AlphaSecurityTable } from "@/modules/alpha/components/AlphaSecurityTable";
import { AlphaServiceBoundary } from "@/modules/alpha/components/AlphaServiceBoundary";
import { alphaQueryKeys, AlphaQueryProvider } from "@/modules/alpha/query";
import { useQuery } from "@tanstack/react-query";
import type { EChartsCoreOption } from "echarts/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  visible: boolean;
};

/** 为数据管理页接入 Alpha 共享查询缓存。 */
export function AlphaDataPage(props: Props) {
  return (
    <AlphaQueryProvider>
      <AlphaServiceBoundary visible={props.visible}>
        <AlphaDataPageContent {...props} />
      </AlphaServiceBoundary>
    </AlphaQueryProvider>
  );
}

/** 连接数据 API 并渲染概览、证券表格和 K 线。 */
function AlphaDataPageContent({ visible }: Props) {
  const { t, i18n } = useTranslation("alpha");
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const status = useQuery({
    queryKey: alphaQueryKeys.overview,
    queryFn: getAlphaOverview,
    enabled: visible,
    refetchInterval: visible ? 10_000 : false,
  });
  const overview = useQuery({
    queryKey: ["alpha", "data-overview"],
    queryFn: getAlphaDataOverview,
    enabled: visible,
  });
  const securities = useQuery({
    queryKey: ["alpha", "securities", 50],
    queryFn: () => getAlphaSecurities(50),
    enabled: visible,
  });
  const bars = useQuery({
    queryKey: ["alpha", "bars", selectedSymbol, "d", "forward"],
    queryFn: () => getAlphaBars(selectedSymbol ?? ""),
    enabled: visible && selectedSymbol !== null,
  });

  useEffect(() => {
    if (!securities.data) return;
    if (
      selectedSymbol &&
      securities.data.items.some((item) => item.vt_symbol === selectedSymbol)
    ) {
      return;
    }
    setSelectedSymbol(securities.data.items[0]?.vt_symbol ?? null);
  }, [securities.data, selectedSymbol]);

  const coverage = useMemo(
    () =>
      Object.entries(overview.data?.bars ?? {}).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    [overview.data?.bars],
  );
  const number = useMemo(
    () => new Intl.NumberFormat(i18n.language),
    [i18n.language],
  );
  const createCoverageOption = useCallback(
    (palette: AlphaChartPalette): EChartsCoreOption => ({
      animationDuration: 160,
      color: [palette.colors[1]],
      grid: { left: 54, right: 18, top: 16, bottom: 32 },
      tooltip: { trigger: "axis" },
      xAxis: {
        type: "category",
        data: coverage.map(([interval]) => interval),
        axisLine: { lineStyle: { color: palette.border } },
        axisLabel: { color: palette.muted },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: palette.muted },
        splitLine: { lineStyle: { color: palette.border } },
      },
      series: [
        {
          type: "bar",
          name: t("data.coverage.rows"),
          data: coverage.map(([, item]) => item.rows),
          barMaxWidth: 44,
        },
      ],
    }),
    [coverage, t],
  );

  const refresh = () => {
    void Promise.all([
      status.refetch(),
      overview.refetch(),
      securities.refetch(),
      selectedSymbol ? bars.refetch() : Promise.resolve(),
    ]);
  };
  const loading =
    status.isPending || overview.isPending || securities.isPending;
  const error = status.error ?? overview.error ?? securities.error;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-5">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-base font-semibold">{t("data.title")}</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("data.description")}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={refresh}>
            {t("common.refresh")}
          </Button>
        </header>

        {error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs text-destructive">
            {String(error)}
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <AlphaMetric
            label={t("data.metrics.database")}
            value={
              status.data?.database_ready
                ? t("data.metrics.ready")
                : t("data.metrics.unavailable")
            }
          />
          <AlphaMetric
            label={t("data.metrics.securities")}
            value={number.format(status.data?.security_count ?? 0)}
          />
          <AlphaMetric
            label={t("data.metrics.rows")}
            value={number.format(overview.data?.total_bar_count ?? 0)}
          />
          <AlphaMetric
            label={t("data.metrics.latest")}
            value={status.data?.latest_trade_date ?? t("common.unavailable")}
          />
        </div>

        <section className="rounded-xl border border-border/70 bg-card p-4">
          <AlphaSectionTitle
            title={t("data.coverage.title")}
            description={t("data.coverage.description")}
          />
          <div className="mt-3 h-60">
            {loading ? (
              <AlphaLoading label={t("common.loading")} />
            ) : coverage.length > 0 ? (
              <AlphaEChart
                visible={visible}
                ariaLabel={t("data.coverage.aria")}
                createOption={createCoverageOption}
              />
            ) : (
              <AlphaEmptyText>{t("data.coverage.empty")}</AlphaEmptyText>
            )}
          </div>
        </section>

        <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(32rem,1fr)_minmax(28rem,1.2fr)]">
          <section className="min-w-0 rounded-xl border border-border/70 bg-card p-4">
            <AlphaSectionTitle
              title={t("data.securities.title")}
              description={t("data.securities.description", {
                count: securities.data?.total ?? 0,
              })}
            />
            <div className="mt-3">
              {securities.isPending ? (
                <div className="h-64">
                  <AlphaLoading label={t("common.loading")} />
                </div>
              ) : securities.data?.items.length ? (
                <AlphaSecurityTable
                  rows={securities.data.items}
                  selectedSymbol={selectedSymbol}
                  onSelect={setSelectedSymbol}
                />
              ) : (
                <div className="h-64">
                  <AlphaEmptyText>{t("data.securities.empty")}</AlphaEmptyText>
                </div>
              )}
            </div>
          </section>

          <section className="min-w-0 rounded-xl border border-border/70 bg-card p-4">
            <AlphaSectionTitle
              title={selectedSymbol ?? t("data.chart.title")}
              description={t("data.chart.description")}
            />
            <div className="mt-3 h-96">
              {bars.isPending && selectedSymbol ? (
                <AlphaLoading label={t("common.loading")} />
              ) : bars.error ? (
                <AlphaEmptyText>{String(bars.error)}</AlphaEmptyText>
              ) : bars.data?.items.length ? (
                <AlphaFinancialChart
                  bars={bars.data.items}
                  visible={visible}
                  ariaLabel={t("data.chart.aria", {
                    symbol: selectedSymbol,
                  })}
                />
              ) : (
                <AlphaEmptyText>{t("data.chart.empty")}</AlphaEmptyText>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

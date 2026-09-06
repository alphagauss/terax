/**
 * 本文件实现工作台图表的懒加载对比标的管理对话框。
 * Dialog 复用 Alpha 证券目录搜索，只维护最多三个标的与有界颜色配置。
 */

import { Button } from "@/components/controls/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/controls/dialog";
import { Input } from "@/components/controls/input";
import { Spinner } from "@/components/ui/spinner";
import { getAlphaSecurities } from "@/modules/alpha/api";
import {
  CHART_COMPARISON_COLORS,
  type ChartComparisonConfig,
  MAX_CHART_COMPARISONS,
  type MarketChartInterval,
} from "@/modules/alpha/chart/model";
import { alphaQueryKeys } from "@/modules/alpha/query";
import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  open: boolean;
  mainSymbol: string | null;
  interval: MarketChartInterval;
  comparisons: readonly ChartComparisonConfig[];
  onOpenChange: (open: boolean) => void;
  onChange: (comparisons: ChartComparisonConfig[]) => void;
};

/** 优先选择尚未使用的对比色，调色板耗尽时才按位置复用。 */
function nextComparisonColor(
  comparisons: readonly ChartComparisonConfig[],
): string {
  return (
    CHART_COMPARISON_COLORS.find(
      (color) => !comparisons.some((item) => item.color === color),
    ) ??
    CHART_COMPARISON_COLORS[comparisons.length % CHART_COMPARISON_COLORS.length]
  );
}

/** 搜索证券并即时添加、删除或修改当前 Chart Panel 的对比配置。 */
export default function ComparisonDialog({
  open,
  mainSymbol,
  interval,
  comparisons,
  onOpenChange,
  onChange,
}: Props) {
  const { t } = useTranslation("alpha");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const queryInput = useMemo(
    () => ({ q: deferredSearch, interval, limit: 30, offset: 0 }),
    [deferredSearch, interval],
  );
  const securitiesQuery = useQuery({
    queryKey: [...alphaQueryKeys.securities, queryInput],
    queryFn: () => getAlphaSecurities(queryInput),
    enabled: open,
  });
  const selectedSymbols = new Set(comparisons.map((item) => item.vtSymbol));
  const candidates = (securitiesQuery.data?.items ?? []).filter(
    (item) =>
      item.vt_symbol !== mainSymbol && !selectedSymbols.has(item.vt_symbol),
  );

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="grid h-[min(34rem,calc(100vh-3rem))] w-[min(38rem,calc(100vw-2rem))] max-w-none grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogHeader className="border-b border-border/60 px-5 py-4">
          <DialogTitle>{t("data.chart.comparisons.dialog.title")}</DialogTitle>
          <DialogDescription>
            {t("data.chart.comparisons.dialog.description", {
              limit: MAX_CHART_COMPARISONS,
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 border-b border-border/60 px-5 py-3">
          {comparisons.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              {t("data.chart.comparisons.dialog.noneSelected")}
            </div>
          ) : (
            comparisons.map((comparison) => (
              <div
                key={comparison.vtSymbol}
                className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {comparison.vtSymbol}
                </span>
                <Input
                  type="color"
                  value={comparison.color}
                  className="h-7 w-10 p-1"
                  aria-label={t("data.chart.comparisons.dialog.color", {
                    symbol: comparison.vtSymbol,
                  })}
                  onChange={(event) =>
                    onChange(
                      comparisons.map((item) =>
                        item.vtSymbol === comparison.vtSymbol
                          ? { ...item, color: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    onChange(
                      comparisons.filter(
                        (item) => item.vtSymbol !== comparison.vtSymbol,
                      ),
                    )
                  }
                >
                  {t("data.chart.comparisons.actions.remove")}
                </Button>
              </div>
            ))
          )}
        </div>
        <div className="min-h-0 overflow-y-auto p-4">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("data.chart.comparisons.dialog.search")}
            aria-label={t("data.chart.comparisons.dialog.search")}
          />
          <div className="mt-3 space-y-1">
            {securitiesQuery.isPending ? (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                <Spinner className="size-3.5" />
                {t("common.loading")}
              </div>
            ) : securitiesQuery.isError ? (
              <div className="px-2 py-3 text-xs text-destructive">
                {t("data.chart.comparisons.dialog.loadError")}
              </div>
            ) : candidates.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                {t("data.chart.comparisons.dialog.noResults")}
              </div>
            ) : (
              candidates.map((security) => (
                <button
                  key={security.vt_symbol}
                  type="button"
                  className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-xs hover:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={comparisons.length >= MAX_CHART_COMPARISONS}
                  onClick={() =>
                    onChange([
                      ...comparisons,
                      {
                        vtSymbol: security.vt_symbol,
                        color: nextComparisonColor(comparisons),
                      },
                    ])
                  }
                >
                  <span className="min-w-0 truncate">{security.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {security.vt_symbol}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
        <DialogFooter className="border-t border-border/60 px-5 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("data.chart.comparisons.actions.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

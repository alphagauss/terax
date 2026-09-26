/** 标的资料展示数据库原始字段，行情日期独立于同步时间和图表状态。 */
import { Button } from "@/components/controls/button";
import { getAlphaSecuritySnapshot } from "@/modules/alpha/api";
import { pricePrecisionFromMinMove } from "@/modules/alpha/market/metadata";
import { alphaQueryKeys } from "@/modules/alpha/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  subscribeAlphaTasks,
  subscribeAlphaEventConnection,
} from "@/modules/alpha/events/tasks";
import { useTranslation } from "react-i18next";

/** 隐藏时停止展示查询，切换标的不会沿用上一标的的价格。 */
export function SecurityDetailsScene({
  symbol,
  visible,
}: {
  symbol: string;
  visible: boolean;
}) {
  const { t, i18n } = useTranslation("alpha");
  const client = useQueryClient();
  const query = useQuery({
    queryKey: alphaQueryKeys.securitySnapshot(symbol),
    queryFn: () => getAlphaSecuritySnapshot(symbol),
    enabled: visible,
    staleTime: 0,
  });
  useEffect(() => {
    if (!visible) return;
    const refresh = () =>
      void client.invalidateQueries({
        queryKey: alphaQueryKeys.securitySnapshot(symbol),
      });
    // 同步可能部分写入后失败，任何同步终态都应重读数据库；合并集中到达的通知。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const releaseTasks = subscribeAlphaTasks((task) => {
      if (task.kind.startsWith("sync") && task.status !== "running") {
        timer ??= setTimeout(() => {
          timer = undefined;
          refresh();
        }, 250);
      }
    });
    const releaseConnection = subscribeAlphaEventConnection((connected) => {
      if (connected) refresh();
    });
    return () => {
      clearTimeout(timer);
      releaseTasks();
      releaseConnection();
    };
  }, [client, symbol, visible]);
  if (query.error)
    return (
      <div role="alert" className="p-3 text-xs text-destructive">
        <p>{t("desk.snapshotFailed")}</p>
        <Button size="xs" variant="ghost" onClick={() => void query.refetch()}>
          {t("common.retry")}
        </Button>
      </div>
    );
  if (!query.data)
    return (
      <p role="status" className="p-3 text-xs text-muted-foreground">
        {t("common.loading")}
      </p>
    );
  const data = query.data;
  const daily = data.latest_daily;
  const precision = pricePrecisionFromMinMove(data.price_tick);
  const priceFormatter = new Intl.NumberFormat(i18n.language, {
    minimumFractionDigits: precision ?? 0,
    maximumFractionDigits: precision ?? 8,
  });
  const quantityFormatter = new Intl.NumberFormat(i18n.language, {
    maximumFractionDigits: 2,
  });
  const number = (value: number | null, price = false) =>
    value === null
      ? "--"
      : (price ? priceFormatter : quantityFormatter).format(value);
  const rows: [string, string][] = daily
    ? [
        ["open", number(daily.open, true)],
        ["high", number(daily.high, true)],
        ["low", number(daily.low, true)],
        [
          "volume",
          number(daily.volume) +
            (data.volume_unit
              ? ` ${data.volume_unit === "share" ? t("desk.details.shares") : data.volume_unit}`
              : ""),
        ],
        ["turnover", number(daily.turnover)],
        ...(daily.upper_limit === null
          ? []
          : [
              ["upperLimit", number(daily.upper_limit, true)] as [
                string,
                string,
              ],
            ]),
        ...(daily.lower_limit === null
          ? []
          : [
              ["lowerLimit", number(daily.lower_limit, true)] as [
                string,
                string,
              ],
            ]),
      ]
    : [];
  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs">
      <div className="shrink-0 space-y-2 border-b p-3">
        <div>
          <strong className="text-sm">{data.name}</strong>
          <p className="mt-1 font-mono text-muted-foreground">
            {data.vt_symbol}
          </p>
        </div>
        {daily ? (
          <>
            <p className="text-muted-foreground">{t("desk.details.close")}</p>
            <p className="text-3xl font-semibold tabular-nums">
              {number(daily.close, true)}
            </p>
            <p className="text-muted-foreground">
              {t("desk.dailyAsOf", { date: daily.trade_date })}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">{t("desk.noDaily")}</p>
        )}
      </div>
      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
        <dl className="space-y-3">
          {rows.map(([field, value]) => (
            <div
              key={field}
              className="flex items-baseline justify-between gap-3"
            >
              <dt className="text-muted-foreground">
                {t(`desk.details.${field}`)}
              </dt>
              <dd className="text-right tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <details className="mt-4 border-t pt-3">
          <summary className="cursor-pointer text-muted-foreground">
            {t("desk.details.profile")}
          </summary>
          <dl className="mt-3 space-y-3">
            {(
              [
                ["exchange", data.exchange],
                ["listedDate", data.listed_date],
                ["timezone", data.timezone],
                ["intervals", data.intervals.join(", ")],
                [
                  "coverage",
                  data.data_start && data.data_end
                    ? `${data.data_start} / ${data.data_end}`
                    : null,
                ],
                ["updated", data.latest_updated_at],
              ] as const
            ).map(([field, value]) => (
              <div key={field}>
                <dt className="text-muted-foreground">
                  {t(`desk.details.${field}`)}
                </dt>
                <dd className="mt-1 break-words">{value || "--"}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
    </div>
  );
}

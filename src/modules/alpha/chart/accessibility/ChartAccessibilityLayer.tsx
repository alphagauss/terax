/**
 * 本文件提供 Alpha Canvas 金融图表之外的可访问数据层。
 * 组件发布当前行情摘要，并通过可聚焦入口展示最多二十根 K 线，不渲染完整历史。
 */

import type { MarketBar, MarketTime } from "@/modules/alpha/market/model";
import { marketTimeKey } from "@/modules/alpha/market/normalize";
import { useTranslation } from "react-i18next";

const MAX_ACCESSIBLE_CHART_ROWS = 20;

type Props = {
  summary: string;
  rows: readonly MarketBar[];
  formatTime: (time: MarketTime) => string;
  formatPrice: (value: number) => string;
  formatVolume: (value: number | null) => string;
};

/** 发布礼貌摘要，并提供最近二十根 K 线的键盘可达数据表。 */
export function ChartAccessibilityLayer({
  summary,
  rows,
  formatTime,
  formatPrice,
  formatVolume,
}: Props) {
  const { t } = useTranslation("alpha");
  const tableRows = rows.slice(-MAX_ACCESSIBLE_CHART_ROWS);

  return (
    <>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {summary}
      </div>
      <details className="sr-only focus-within:not-sr-only focus-within:absolute focus-within:left-2 focus-within:top-2 focus-within:z-30 focus-within:max-h-[calc(100%-1rem)] focus-within:w-[min(36rem,calc(100%-1rem))] focus-within:overflow-auto focus-within:rounded-md focus-within:border focus-within:border-border focus-within:bg-background focus-within:p-2 focus-within:text-xs focus-within:shadow-lg">
        <summary className="cursor-pointer text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t("data.chart.accessibility.openTable")}
        </summary>
        <table className="mt-2 min-w-full text-left">
          <caption className="sr-only">
            {t("data.chart.accessibility.tableCaption")}
          </caption>
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="px-1 py-1">
                {t("data.chart.accessibility.time")}
              </th>
              <th scope="col" className="px-1 py-1 text-right">
                {t("data.chart.legend.open")}
              </th>
              <th scope="col" className="px-1 py-1 text-right">
                {t("data.chart.legend.high")}
              </th>
              <th scope="col" className="px-1 py-1 text-right">
                {t("data.chart.legend.low")}
              </th>
              <th scope="col" className="px-1 py-1 text-right">
                {t("data.chart.legend.close")}
              </th>
              <th scope="col" className="px-1 py-1 text-right">
                {t("data.chart.legend.volume")}
              </th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {tableRows.map((bar) => (
              <tr key={marketTimeKey(bar.time)}>
                <td className="whitespace-nowrap px-1 py-1">
                  {formatTime(bar.time)}
                </td>
                <td className="px-1 py-1 text-right">
                  {formatPrice(bar.open)}
                </td>
                <td className="px-1 py-1 text-right">
                  {formatPrice(bar.high)}
                </td>
                <td className="px-1 py-1 text-right">{formatPrice(bar.low)}</td>
                <td className="px-1 py-1 text-right">
                  {formatPrice(bar.close)}
                </td>
                <td className="px-1 py-1 text-right">
                  {formatVolume(bar.volume)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

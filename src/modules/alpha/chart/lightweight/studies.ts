/**
 * 本文件把引擎无关指标结果路由并转换为 Lightweight Charts 数据。
 * 纯函数统一 pane 上限、空点和 histogram 正负颜色，不持有图表实例。
 */

import { financialChartTime } from "@/modules/alpha/chart/lightweight/data";
import type { FinancialChartPalette } from "@/modules/alpha/chart/model";
import {
  MAX_SEPARATE_CHART_STUDIES,
  type ChartStudyInstance,
  type ChartStudyResult,
  type ChartStudyStyle,
} from "@/modules/alpha/chart/studies/model";
import type {
  HistogramData,
  LineData,
  Time,
  WhitespaceData,
} from "lightweight-charts";

export type RoutedChartStudy = {
  instance: ChartStudyInstance;
  result: ChartStudyResult;
  paneIndex: number;
};

export type ChartStudySeriesData =
  | Array<LineData<Time> | WhitespaceData<Time>>
  | Array<HistogramData<Time> | WhitespaceData<Time>>;

/** 按配置顺序路由可见结果，并对独立 pane 数量执行硬保护。 */
export function routeChartStudies(
  results: readonly ChartStudyResult[],
  instances: readonly ChartStudyInstance[],
  showVolume: boolean,
): RoutedChartStudy[] {
  const resultsById = new Map(
    results.map((result) => [result.instanceId, result]),
  );
  const routed: RoutedChartStudy[] = [];
  let separateCount = 0;
  for (const instance of instances) {
    if (!instance.visible) continue;
    const result = resultsById.get(instance.instanceId);
    if (!result) continue;
    if (result.pane === "separate") {
      if (separateCount >= MAX_SEPARATE_CHART_STUDIES) continue;
      routed.push({
        instance,
        result,
        paneIndex: (showVolume ? 2 : 1) + separateCount,
      });
      separateCount += 1;
    } else {
      routed.push({ instance, result, paneIndex: 0 });
    }
  }
  return routed;
}

/** 把一个 output 转换为带空点和稳定颜色的 series payload。 */
export function buildChartStudySeriesData(
  result: ChartStudyResult["outputs"][number],
  style: ChartStudyStyle,
  palette: FinancialChartPalette,
): ChartStudySeriesData {
  if (result.kind === "histogram") {
    return result.points.map((point) => {
      const time = financialChartTime(point.time);
      if (point.value === null) return { time };
      return {
        time,
        value: point.value,
        color:
          point.value >= 0
            ? (style.positiveColor ?? palette.up)
            : (style.negativeColor ?? palette.down),
      };
    });
  }
  return result.points.map((point) => {
    const time = financialChartTime(point.time);
    return point.value === null ? { time } : { time, value: point.value };
  });
}

/** 提取每个实例各 output 的最后一个有限值，供十字线离开后的 legend 使用。 */
export function latestChartStudyValues(
  results: readonly ChartStudyResult[],
): Record<string, Record<string, number | null>> {
  return Object.fromEntries(
    results.map((result) => [
      result.instanceId,
      Object.fromEntries(
        result.outputs.map((output) => {
          let value: number | null = null;
          for (let index = output.points.length - 1; index >= 0; index -= 1) {
            const candidate = output.points[index]?.value;
            if (candidate !== null && candidate !== undefined) {
              value = candidate;
              break;
            }
          }
          return [output.id, value];
        }),
      ),
    ]),
  );
}

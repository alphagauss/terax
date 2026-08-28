/**
 * 本文件提供 Alpha 金融图表的有界导出能力。
 * 负责安全文件名、CSV 序列化、截图主题铺底和 Blob 下载，不读取页面或查询状态。
 */

import type { MarketBar, MarketTime } from "@/modules/alpha/market/model";

export const MAX_CHART_EXPORT_BARS = 50_000;

type ChartExportExtension = "png" | "csv";

function safeFilenamePart(value: string, fallback: string): string {
  const safe = value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "");
  return safe || fallback;
}

/** 构造不含路径字符且保留 Unicode 证券名称的稳定导出文件名。 */
export function buildChartExportFilename(
  symbol: string | null,
  interval: string | null,
  extension: ChartExportExtension,
): string {
  const safeSymbol = safeFilenamePart(symbol ?? "", "chart");
  const safeInterval = safeFilenamePart(interval ?? "", "bars");
  return `chart-${safeSymbol}-${safeInterval}.${extension}`;
}

/** 按 RFC 4180 的字段规则转义 CSV 单元格，空值输出为空单元格。 */
export function escapeCsvCell(
  value: string | number | null | undefined,
): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function marketTimeForCsv(time: MarketTime): string {
  return time.kind === "trading-day"
    ? time.date
    : new Date(time.epochSeconds * 1_000).toISOString();
}

/**
 * 将已加载行情按固定八列序列化为 CSV。
 *
 * 在构造字符串前拒绝超过 50,000 根的输入，避免 WebView 主线程处理无界内容。
 */
export function buildMarketBarsCsv(bars: readonly MarketBar[]): string {
  if (bars.length > MAX_CHART_EXPORT_BARS) {
    throw new RangeError("chart-export-bar-limit");
  }
  const rows = bars.map((bar) =>
    [
      marketTimeForCsv(bar.time),
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      bar.volume,
      bar.amount,
      bar.openInterest,
    ]
      .map(escapeCsvCell)
      .join(","),
  );
  return ["time,open,high,low,close,volume,amount,open_interest", ...rows].join(
    "\n",
  );
}

/** 为透明图表截图创建一次性主题背景副本，不修改原 Canvas。 */
export function addChartScreenshotBackground(
  source: HTMLCanvasElement,
  backgroundColor: string,
): HTMLCanvasElement | null {
  const canvas = source.ownerDocument.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = backgroundColor;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0);
  return canvas;
}

/** 通过临时 Blob URL 触发一次下载，并在同步触发后立即释放 URL。 */
export function downloadChartBlob(blob: Blob, filename: string): void {
  if (
    typeof URL.createObjectURL !== "function" ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    throw new Error("blob-url-unavailable");
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}

/** 将 Canvas 编码为 PNG Blob 后下载，编码失败时拒绝 Promise。 */
export function downloadChartPng(
  canvas: HTMLCanvasElement,
  filename: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== "function") {
      reject(new Error("canvas-blob-unavailable"));
      return;
    }
    try {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("canvas-blob-unavailable"));
          return;
        }
        try {
          downloadChartBlob(blob, filename);
          resolve();
        } catch (error) {
          reject(error);
        }
      }, "image/png");
    } catch (error) {
      reject(error);
    }
  });
}

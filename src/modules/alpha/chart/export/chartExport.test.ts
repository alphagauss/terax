/**
 * 本文件测试 Alpha 图表导出的纯函数和浏览器下载边界。
 * 重点锁定文件名、CSV 时间与转义、行数上限、主题铺底和 Blob URL 回收。
 */

// @vitest-environment happy-dom

import {
  addChartScreenshotBackground,
  buildChartExportFilename,
  buildMarketBarsCsv,
  downloadChartBlob,
  downloadChartPng,
  escapeCsvCell,
  MAX_CHART_EXPORT_BARS,
} from "@/modules/alpha/chart/export/chartExport";
import type { MarketBar } from "@/modules/alpha/market/model";
import { afterEach, describe, expect, it, vi } from "vitest";

function marketBar(overrides: Partial<MarketBar> = {}): MarketBar {
  return {
    time: { kind: "trading-day", date: "2026-08-28" },
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: null,
    amount: null,
    openInterest: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chartExport", () => {
  it("生成安全文件名并保留中文证券名称", () => {
    expect(buildChartExportFilename(" 平安银行/主图 ", "1 H", "png")).toBe(
      "chart-平安银行-主图-1-h.png",
    );
    expect(buildChartExportFilename("../A:B", "", "csv")).toBe(
      "chart-a-b-bars.csv",
    );
    expect(buildChartExportFilename(null, null, "png")).toBe(
      "chart-chart-bars.png",
    );
  });

  it("转义逗号、引号和换行单元格", () => {
    expect(escapeCsvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(escapeCsvCell(null)).toBe("");
  });

  it("按固定顺序输出交易日、UTC 时间和空扩展字段", () => {
    expect(
      buildMarketBarsCsv([
        marketBar(),
        marketBar({
          time: { kind: "instant", epochSeconds: 0 },
          open: 20,
          high: 22,
          low: 19,
          close: 21,
          volume: 100,
          amount: 2_000,
          openInterest: 3,
        }),
      ]),
    ).toBe(
      [
        "time,open,high,low,close,volume,amount,open_interest",
        "2026-08-28,10,12,9,11,,,",
        "1970-01-01T00:00:00.000Z,20,22,19,21,100,2000,3",
      ].join("\n"),
    );
  });

  it("在序列化前拒绝超过五万根行情", () => {
    const bars = Array<MarketBar>(MAX_CHART_EXPORT_BARS + 1).fill(marketBar());
    expect(() => buildMarketBarsCsv(bars)).toThrow(RangeError);
  });

  it("创建带主题背景的截图副本", () => {
    const source = document.createElement("canvas");
    source.width = 640;
    source.height = 360;
    const fillRect = vi.fn();
    const drawImage = vi.fn();
    const output = document.createElement("canvas");
    vi.spyOn(source.ownerDocument, "createElement").mockReturnValueOnce(output);
    vi.spyOn(output, "getContext").mockReturnValue({
      fillStyle: "",
      fillRect,
      drawImage,
    } as unknown as CanvasRenderingContext2D);

    expect(addChartScreenshotBackground(source, "#101010")).toBe(output);
    expect(output.width).toBe(640);
    expect(output.height).toBe(360);
    expect(fillRect).toHaveBeenCalledWith(0, 0, 640, 360);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0);
  });

  it("下载 Blob 后回收临时 URL", () => {
    const click = vi.fn();
    const createObjectURL = vi.fn(() => "blob:chart");
    const revokeObjectURL = vi.fn();
    vi.spyOn(URL, "createObjectURL").mockImplementation(createObjectURL);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeObjectURL);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(click);

    downloadChartBlob(new Blob(["csv"]), "chart.csv");

    expect(click).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:chart");
  });

  it("将截图编码为 PNG 并触发一次下载", async () => {
    const canvas = document.createElement("canvas");
    const blob = new Blob(["png"], { type: "image/png" });
    vi.spyOn(canvas, "toBlob").mockImplementation((callback) => callback(blob));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:png");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    await downloadChartPng(canvas, "chart.png");

    expect(click).toHaveBeenCalledOnce();
  });

  it("Blob URL 不可用时明确失败", () => {
    const original = URL.createObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: undefined,
    });
    try {
      expect(() => downloadChartBlob(new Blob(), "chart.csv")).toThrow(
        "blob-url-unavailable",
      );
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: original,
      });
    }
  });
});

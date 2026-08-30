/**
 * 本文件测试行情 scene 的排他游标分页和查询键隔离。
 * 重点锁定历史时间顺序、旧请求隔离和指标只按可见实际区间启用。
 */

// @vitest-environment happy-dom

import type {
  ChartComparisonConfig,
  MarketChartDensity,
  MarketChartOptions,
} from "@/modules/alpha/chart/model";
import type { ChartStudyInstance } from "@/modules/alpha/chart/studies/model";
import type { MarketBarPage } from "@/modules/alpha/market/model";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  calculateAlphaStudies: vi.fn(),
  getAlphaBars: vi.fn(),
  getAlphaSecurity: vi.fn(),
  frameProps: null as Record<string, unknown> | null,
  acquireRealtime: vi.fn(),
  releaseRealtime: vi.fn(),
}));

vi.mock("@/modules/alpha/api", () => ({
  calculateAlphaStudies: mocks.calculateAlphaStudies,
  getAlphaBars: mocks.getAlphaBars,
  getAlphaSecurity: mocks.getAlphaSecurity,
}));

vi.mock("@/modules/alpha/chart/components/FinancialChartFrame", () => ({
  FinancialChartFrame: (props: Record<string, unknown>) => {
    mocks.frameProps = props;
    return null;
  },
}));

vi.mock("@/modules/alpha/realtime/MarketDataFeed", () => ({
  acquireMarketData: mocks.acquireRealtime,
}));

import { MarketChartScene } from "@/modules/alpha/chart/scenes/MarketChartScene";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

const DEFAULT_OPTIONS: MarketChartOptions = {
  interval: "d",
  adjust: "forward",
  chartType: "candlestick",
  showVolume: true,
  paneRatios: { main: 8, volume: 2 },
};

const SMA_STUDY: ChartStudyInstance = {
  instanceId: "sma-1",
  type: "sma",
  params: { period: 20 },
  visible: true,
  styles: { line: { color: "#fff", lineWidth: 1 } },
};

function page(
  dates: string[],
  hasMoreBefore: boolean,
  nextBefore: string | null,
): MarketBarPage {
  return {
    items: dates.map((date, index) => ({
      time: { kind: "trading-day" as const, date },
      open: 10,
      high: 12,
      low: 9,
      close: 11 + index,
      volume: 100,
      amount: 1_000,
      openInterest: null,
    })),
    hasMoreBefore,
    nextBefore,
    actualStart: dates[0] ?? null,
    actualEnd: dates[dates.length - 1] ?? null,
    referenceClose: 10,
    referenceTime: { kind: "trading-day", date: "2026-07-26" },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("MarketChartScene", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  let queryClient: QueryClient;
  let container: HTMLDivElement;

  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.getAlphaBars.mockReset();
    mocks.calculateAlphaStudies.mockReset().mockResolvedValue({
      actualStart: "2026-07-29",
      actualEnd: "2026-07-30",
      items: [],
    });
    mocks.getAlphaSecurity.mockReset().mockResolvedValue({
      vt_symbol: "000001.SZSE",
      symbol: "000001",
      exchange: "SZSE",
      name: "平安银行",
      intervals: ["1m", "1h", "d", "w", "tick", "future"],
      timezone: "Asia/Shanghai",
      price_color_convention: "up-red",
      volume_unit: "share",
      price_tick: 0.01,
    });
    mocks.frameProps = null;
    mocks.releaseRealtime.mockReset();
    mocks.acquireRealtime.mockReset().mockReturnValue({
      dataKey: "000001.SZSE|d|forward",
      getState: () => ({ status: "live" }),
      subscribeState: (listener: (state: { status: string }) => void) => {
        listener({ status: "live" });
        return vi.fn();
      },
      subscribeData: () => vi.fn(),
      release: mocks.releaseRealtime,
    });
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    queryClient.clear();
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  function render(
    symbol: string,
    options: MarketChartOptions = DEFAULT_OPTIONS,
    onOptionsChange = vi.fn(),
    density: MarketChartDensity = "panel",
    studies: readonly ChartStudyInstance[] = [],
    visible = true,
    comparisons: readonly ChartComparisonConfig[] = [],
    realtimeEnabled = false,
  ) {
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(MarketChartScene, {
          vtSymbol: symbol,
          visible,
          options,
          density,
          onOptionsChange,
          studies,
          comparisons,
          realtimeEnabled,
          onRealtimeEnabledChange: vi.fn(),
        }),
      ),
    );
  }

  it("使用排他游标加载更早页面并按时间升序合并", async () => {
    mocks.getAlphaBars
      .mockResolvedValueOnce(
        page(["2026-07-29", "2026-07-30"], true, "2026-07-29"),
      )
      .mockResolvedValueOnce(page(["2026-07-27", "2026-07-28"], false, null));

    await act(async () => render("000001.SZSE"));
    await flush();
    await act(async () => {
      (mocks.frameProps?.onRequestMore as (() => void) | undefined)?.();
    });
    await flush();

    expect(mocks.getAlphaBars).toHaveBeenNthCalledWith(
      2,
      "000001.SZSE",
      expect.objectContaining({ before: "2026-07-29" }),
    );
    const bars = mocks.frameProps?.bars as
      | Array<{ time: { date: string } }>
      | undefined;
    expect(bars?.map((bar) => bar.time.date)).toEqual([
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
    ]);
  });

  it("服务端游标没有前进时停止继续分页", async () => {
    mocks.getAlphaBars
      .mockResolvedValueOnce(
        page(["2026-07-29", "2026-07-30"], true, "2026-07-29"),
      )
      .mockResolvedValueOnce(
        page(["2026-07-27", "2026-07-28"], true, "2026-07-29"),
      );

    await act(async () => render("000001.SZSE"));
    await flush();
    await act(async () => {
      (mocks.frameProps?.onRequestMore as (() => void) | undefined)?.();
    });
    await flush();

    expect(mocks.frameProps?.hasMoreBefore).toBe(false);
    (mocks.frameProps?.onRequestMore as (() => void) | undefined)?.();
    expect(mocks.getAlphaBars).toHaveBeenCalledTimes(2);
  });

  it("只在页面可见且存在可见指标时按实际行情区间请求计算", async () => {
    mocks.getAlphaBars.mockResolvedValue(
      page(["2026-07-29", "2026-07-30"], false, null),
    );

    await act(async () => render("000001.SZSE"));
    await flush();
    expect(mocks.calculateAlphaStudies).not.toHaveBeenCalled();

    await act(async () =>
      render(
        "000001.SZSE",
        DEFAULT_OPTIONS,
        vi.fn(),
        "panel",
        [SMA_STUDY],
        false,
      ),
    );
    await flush();
    expect(mocks.calculateAlphaStudies).not.toHaveBeenCalled();

    await act(async () =>
      render("000001.SZSE", DEFAULT_OPTIONS, vi.fn(), "panel", [SMA_STUDY]),
    );
    await flush();

    expect(mocks.calculateAlphaStudies).toHaveBeenCalledWith({
      vtSymbol: "000001.SZSE",
      interval: "d",
      adjust: "forward",
      start: "2026-07-29",
      end: "2026-07-30",
      studies: [{ instanceId: "sma-1", type: "sma", params: { period: 20 } }],
    });
  });

  it("历史 prepend 改变实际起点后重新请求完整指标覆盖", async () => {
    mocks.getAlphaBars
      .mockResolvedValueOnce(
        page(["2026-07-29", "2026-07-30"], true, "2026-07-29"),
      )
      .mockResolvedValueOnce(page(["2026-07-27", "2026-07-28"], false, null));

    await act(async () =>
      render("000001.SZSE", DEFAULT_OPTIONS, vi.fn(), "panel", [SMA_STUDY]),
    );
    await flush();
    await act(async () => {
      (mocks.frameProps?.onRequestMore as (() => void) | undefined)?.();
    });
    await flush();

    expect(mocks.calculateAlphaStudies).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        start: "2026-07-27",
        end: "2026-07-30",
      }),
    );
  });

  it("标的切换后忽略旧查询完成结果", async () => {
    let resolveOld: ((value: MarketBarPage) => void) | null = null;
    mocks.getAlphaBars.mockImplementation((symbol: string) => {
      if (symbol === "OLD.SSE") {
        return new Promise<MarketBarPage>((resolve) => {
          resolveOld = resolve;
        });
      }
      return Promise.resolve(page(["2026-07-30"], false, null));
    });

    await act(async () => render("OLD.SSE"));
    await act(async () => render("NEW.SSE"));
    await flush();
    expect(mocks.frameProps?.dataKey).toBe("NEW.SSE|d|forward");

    await act(async () => {
      resolveOld?.(page(["2020-01-01"], false, null));
    });
    await flush();

    expect(mocks.frameProps?.dataKey).toBe("NEW.SSE|d|forward");
    const bars = mocks.frameProps?.bars as
      | Array<{ time: { date: string } }>
      | undefined;
    expect(bars?.[0]?.time.date).toBe("2026-07-30");
  });

  it("按受控周期和复权隔离查询并只暴露权威 K 线周期", async () => {
    mocks.getAlphaBars.mockResolvedValue(page(["2026-07-30"], false, null));

    await act(async () => render("000001.SZSE"));
    await flush();
    expect(mocks.frameProps?.availableIntervals).toEqual([
      "1m",
      "1h",
      "d",
      "w",
    ]);

    await act(async () =>
      render("000001.SZSE", {
        interval: "1h",
        adjust: "none",
        chartType: "line",
        showVolume: false,
        paneRatios: { main: 7, volume: 3 },
      }),
    );
    await flush();

    expect(mocks.getAlphaBars).toHaveBeenLastCalledWith(
      "000001.SZSE",
      expect.objectContaining({ interval: "1h", adjust: "none" }),
    );
    expect(mocks.frameProps?.dataKey).toBe("000001.SZSE|1h|none");
    expect(mocks.frameProps?.options).toEqual({
      interval: "1h",
      adjust: "none",
      chartType: "line",
      showVolume: false,
      paneRatios: { main: 7, volume: 3 },
    });
    expect(mocks.frameProps?.metadata).toMatchObject({
      timezone: "Asia/Shanghai",
      minMove: 0.01,
      pricePrecision: 2,
      priceColorConvention: "up-red",
    });
    expect(mocks.frameProps?.priceReference).toEqual({
      previousClose: 10,
      referenceTime: { kind: "trading-day", date: "2026-07-26" },
    });
  });

  it("紧凑数据预览复用证券详情提供权威价格和时间语义", async () => {
    mocks.getAlphaBars.mockResolvedValue(page(["2026-07-30"], false, null));

    await act(async () =>
      render("000001.SZSE", DEFAULT_OPTIONS, vi.fn(), "compact"),
    );
    await flush();

    expect(mocks.getAlphaSecurity).toHaveBeenCalledWith("000001.SZSE");
    expect(mocks.getAlphaBars).toHaveBeenCalledWith(
      "000001.SZSE",
      expect.objectContaining({ interval: "d", adjust: "forward" }),
    );
  });

  it("证券详情没有可用 K 线周期时只保留当前配置", async () => {
    mocks.getAlphaSecurity.mockResolvedValue({
      vt_symbol: "000001.SZSE",
      symbol: "000001",
      exchange: "SZSE",
      name: "平安银行",
      intervals: ["tick", "future"],
      timezone: "Asia/Shanghai",
      price_color_convention: "up-red",
      volume_unit: "share",
      price_tick: 0.01,
    });
    mocks.getAlphaBars.mockResolvedValue(page([], false, null));

    await act(async () => render("000001.SZSE"));
    await flush();

    expect(mocks.frameProps?.availableIntervals).toEqual(["d"]);
  });

  it("初次加载失败后可以在图表内重试", async () => {
    mocks.getAlphaBars
      .mockRejectedValueOnce(new Error("internal detail"))
      .mockResolvedValueOnce(page(["2026-07-30"], false, null));

    await act(async () => render("000001.SZSE"));
    await flush();
    expect(mocks.frameProps?.status).toBe("error");

    await act(async () => {
      (mocks.frameProps?.onRetry as (() => void) | undefined)?.();
    });
    await flush();

    expect(mocks.getAlphaBars).toHaveBeenCalledTimes(2);
    expect(mocks.frameProps?.status).toBe("ready");
  });

  it("未配置对比时不发起范围查询，配置后按主图实际范围读取并归一化", async () => {
    mocks.getAlphaBars.mockImplementation(
      (symbol: string, query: { start?: string; end?: string }) => {
        if (symbol === "600000.SSE") {
          return Promise.resolve({
            ...page(["2026-07-29", "2026-07-30"], false, null),
            items: [
              { ...page(["2026-07-29"], false, null).items[0], close: 100 },
              { ...page(["2026-07-30"], false, null).items[0], close: 110 },
            ],
            actualStart: query.start ?? null,
            actualEnd: query.end ?? null,
          });
        }
        return Promise.resolve(page(["2026-07-29", "2026-07-30"], false, null));
      },
    );

    await act(async () => render("000001.SZSE"));
    await flush();
    expect(mocks.getAlphaBars).toHaveBeenCalledOnce();

    await act(async () =>
      render("000001.SZSE", DEFAULT_OPTIONS, vi.fn(), "panel", [], true, [
        { vtSymbol: "600000.SSE", color: "#d9a441" },
      ]),
    );
    await flush();

    expect(mocks.getAlphaBars).toHaveBeenCalledWith("600000.SSE", {
      interval: "d",
      adjust: "forward",
      start: "2026-07-29",
      end: "2026-07-30",
      limit: 2,
    });
    expect(mocks.frameProps?.comparisonStates).toEqual([
      expect.objectContaining({
        vtSymbol: "600000.SSE",
        status: "ready",
        partial: false,
      }),
    ]);
    const series = mocks.frameProps?.comparisonSeries as Array<{
      vtSymbol: string;
      points: Array<{ value: number }>;
    }>;
    expect(series.map((item) => item.vtSymbol)).toEqual([
      "000001.SZSE",
      "600000.SSE",
    ]);
    expect(series[1].points[1].value).toBeCloseTo(10);

    const callsBeforeSameRange = mocks.getAlphaBars.mock.calls.length;
    await act(async () =>
      render("000001.SZSE", DEFAULT_OPTIONS, vi.fn(), "panel", [], true, [
        { vtSymbol: "600000.SSE", color: "#d9a441" },
      ]),
    );
    await flush();
    expect(mocks.getAlphaBars).toHaveBeenCalledTimes(callsBeforeSameRange);
  });

  it("排除主标的并让单个对比失败保持局部状态", async () => {
    mocks.getAlphaBars.mockImplementation((symbol: string) =>
      symbol === "600000.SSE"
        ? Promise.reject(new Error("comparison failed"))
        : Promise.resolve(page(["2026-07-29", "2026-07-30"], false, null)),
    );

    await act(async () =>
      render("000001.SZSE", DEFAULT_OPTIONS, vi.fn(), "panel", [], true, [
        { vtSymbol: "000001.SZSE", color: "#4daafc" },
        { vtSymbol: "600000.SSE", color: "#d9a441" },
      ]),
    );
    await flush();

    const mainRangeCalls = mocks.getAlphaBars.mock.calls.filter(
      ([symbol, query]) => symbol === "000001.SZSE" && query?.start,
    );
    expect(mainRangeCalls).toHaveLength(0);
    expect(mocks.frameProps?.comparisons).toEqual([
      { vtSymbol: "600000.SSE", color: "#d9a441" },
    ]);
    expect(mocks.frameProps?.comparisonStates).toEqual([
      expect.objectContaining({
        vtSymbol: "600000.SSE",
        status: "error",
      }),
    ]);
    expect(mocks.frameProps?.status).toBe("ready");
  });

  it("历史 prepend 后扩展对比查询范围", async () => {
    let mainCalls = 0;
    mocks.getAlphaBars.mockImplementation(
      (symbol: string, query: { start?: string }) => {
        if (symbol === "600000.SSE") {
          return Promise.resolve({
            ...page(
              query.start === "2026-07-27"
                ? ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30"]
                : ["2026-07-29", "2026-07-30"],
              false,
              null,
            ),
            actualStart: query.start ?? null,
          });
        }
        mainCalls += 1;
        return Promise.resolve(
          mainCalls === 1
            ? page(["2026-07-29", "2026-07-30"], true, "2026-07-29")
            : page(["2026-07-27", "2026-07-28"], false, null),
        );
      },
    );

    await act(async () =>
      render("000001.SZSE", DEFAULT_OPTIONS, vi.fn(), "panel", [], true, [
        { vtSymbol: "600000.SSE", color: "#d9a441" },
      ]),
    );
    await flush();
    await act(async () => {
      (mocks.frameProps?.onRequestMore as (() => void) | undefined)?.();
    });
    await flush();

    expect(mocks.getAlphaBars).toHaveBeenCalledWith(
      "600000.SSE",
      expect.objectContaining({ start: "2026-07-27", limit: 4 }),
    );
  });

  it("主图超过五千根时保持查询有界并标记局部覆盖", async () => {
    const longItems = Array.from({ length: 5_001 }, (_, index) => ({
      time: { kind: "instant" as const, epochSeconds: index + 1 },
      open: 10,
      high: 12,
      low: 9,
      close: 11 + index / 10_000,
      volume: 100,
      amount: 1_000,
      openInterest: null,
    }));
    mocks.getAlphaBars.mockImplementation((symbol: string) =>
      Promise.resolve({
        ...page([], false, null),
        items: symbol === "600000.SSE" ? longItems.slice(-5_000) : longItems,
        actualStart: symbol === "600000.SSE" ? "2020-01-02" : "2020-01-01",
        actualEnd: "2026-07-30",
      }),
    );

    await act(async () =>
      render(
        "000001.SZSE",
        { ...DEFAULT_OPTIONS, interval: "1h" },
        vi.fn(),
        "panel",
        [],
        true,
        [{ vtSymbol: "600000.SSE", color: "#d9a441" }],
      ),
    );
    await flush();

    expect(mocks.getAlphaBars).toHaveBeenCalledWith(
      "600000.SSE",
      expect.objectContaining({ limit: 5_000 }),
    );
    expect(mocks.frameProps?.comparisonStates).toEqual([
      expect.objectContaining({ status: "ready", partial: true }),
    ]);
  });

  it("只在显式启用且页面可见时加载共享实时 Hub", async () => {
    mocks.getAlphaBars.mockResolvedValue(
      page(["2026-07-29", "2026-07-30"], false, null),
    );
    await act(async () =>
      render(
        "000001.SZSE",
        DEFAULT_OPTIONS,
        vi.fn(),
        "panel",
        [],
        true,
        [],
        false,
      ),
    );
    await flush();
    expect(mocks.acquireRealtime).not.toHaveBeenCalled();

    await act(async () =>
      render(
        "000001.SZSE",
        DEFAULT_OPTIONS,
        vi.fn(),
        "panel",
        [],
        true,
        [],
        true,
      ),
    );
    await flush();
    expect(mocks.acquireRealtime).toHaveBeenCalledWith({
      vtSymbol: "000001.SZSE",
      interval: "d",
      adjust: "forward",
    });
    expect(mocks.frameProps?.realtimeState).toEqual({ status: "live" });

    await act(async () =>
      render(
        "000001.SZSE",
        DEFAULT_OPTIONS,
        vi.fn(),
        "panel",
        [],
        false,
        [],
        true,
      ),
    );
    await flush();
    expect(mocks.releaseRealtime).toHaveBeenCalledOnce();
  });
});

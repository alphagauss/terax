/**
 * 本文件测试行情 scene 的排他游标分页和查询键隔离。
 * 重点锁定更早页面的时间顺序，以及标的切换后旧请求不能覆盖当前图表。
 */

// @vitest-environment happy-dom

import type { MarketBarPage } from "@/modules/alpha/market/model";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAlphaBars: vi.fn(),
  frameProps: null as Record<string, unknown> | null,
}));

vi.mock("@/modules/alpha/api", () => ({
  getAlphaBars: mocks.getAlphaBars,
}));

vi.mock("@/modules/alpha/chart/components/FinancialChartFrame", () => ({
  FinancialChartFrame: (props: Record<string, unknown>) => {
    mocks.frameProps = props;
    return null;
  },
}));

import { MarketChartScene } from "@/modules/alpha/chart/scenes/MarketChartScene";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
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
  };
}

async function flush(): Promise<void> {
  await act(async () => {
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
    mocks.frameProps = null;
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

  function render(symbol: string) {
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(MarketChartScene, { vtSymbol: symbol, visible: true }),
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
});

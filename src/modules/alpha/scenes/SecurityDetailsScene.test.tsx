// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SecurityDetailsScene } from "@/modules/alpha/scenes/SecurityDetailsScene";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  task: null as null | ((task: { kind: string; status: string }) => void),
  connection: null as null | ((connected: boolean) => void),
}));
vi.mock("@/modules/alpha/events/tasks", () => ({
  subscribeAlphaTasks: (callback: NonNullable<typeof mocks.task>) => {
    mocks.task = callback;
    return () => {
      mocks.task = null;
    };
  },
  subscribeAlphaEventConnection: (
    callback: NonNullable<typeof mocks.connection>,
  ) => {
    mocks.connection = callback;
    return () => {
      mocks.connection = null;
    };
  },
}));
vi.mock("@/modules/alpha/api", () => ({
  getAlphaSecuritySnapshot: mocks.snapshot,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { date?: string }) =>
      values?.date ? `${key} ${values.date}` : key,
    i18n: { language: "en" },
  }),
}));

it("展示原始日期和零成交量，隐藏不查询，切换标的不沿用旧价格，无日线仍展示资料", async () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const profile = {
    name: "First",
    vt_symbol: "000001.SZSE",
    exchange: "SZSE",
    timezone: "Asia/Shanghai",
    price_tick: 0.01,
    volume_unit: "share",
    listed_date: "1991-04-03",
    intervals: ["d"],
    data_start: null,
    data_end: null,
    latest_updated_at: "2026-09-26",
  };
  let resolveSecond: ((value: unknown) => void) | undefined;
  mocks.snapshot.mockImplementation((symbol: string) =>
    symbol === "000001.SZSE"
      ? Promise.resolve({
          ...profile,
          latest_daily: {
            trade_date: "2026-05-15",
            close: 10.99,
            open: 11,
            high: 12,
            low: 10,
            volume: 0,
            turnover: null,
            upper_limit: null,
            lower_limit: null,
          },
        })
      : new Promise((resolve) => {
          resolveSecond = resolve;
        }),
  );
  const render = (symbol: string, visible: boolean) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <SecurityDetailsScene symbol={symbol} visible={visible} />
        </QueryClientProvider>,
      ),
    );
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  try {
    await render("000001.SZSE", false);
    expect(mocks.snapshot).not.toHaveBeenCalled();
    await render("000001.SZSE", true);
    await settle();
    expect(element.textContent).toContain("10.99");
    expect(element.textContent).toContain("desk.dailyAsOf 2026-05-15");
    expect(element.textContent).toContain("0 desk.details.shares");
    expect(element.textContent).not.toContain("desk.details.upperLimit");
    const count = mocks.snapshot.mock.calls.length;
    await act(async () => {
      mocks.task?.({ kind: "sync.bars", status: "failed" });
      mocks.task?.({ kind: "sync.bars", status: "succeeded" });
      await new Promise((resolve) => setTimeout(resolve, 280));
    });
    expect(mocks.snapshot).toHaveBeenCalledTimes(count + 1);
    await act(async () => mocks.connection?.(true));
    expect(mocks.snapshot).toHaveBeenCalledTimes(count + 2);
    await render("000001.SZSE", false);
    expect(mocks.task).toBeNull();
    expect(mocks.connection).toBeNull();
    await render("600000.SSE", true);
    expect(element.textContent).not.toContain("10.99");
    await act(async () =>
      resolveSecond?.({
        ...profile,
        name: "Second",
        vt_symbol: "600000.SSE",
        latest_daily: null,
      }),
    );
    await settle();
    expect(element.textContent).toContain("Second");
    expect(element.textContent).toContain("desk.noDaily");
    expect(element.textContent).not.toContain("desk.details.close");
  } finally {
    act(() => root.unmount());
    client.clear();
  }
});

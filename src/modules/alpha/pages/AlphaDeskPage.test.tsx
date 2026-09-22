// @vitest-environment happy-dom
import { act, type ReactNode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  write: vi.fn(),
  mounts: { chart: 0, backtests: 0 },
  visible: {} as Record<string, boolean>,
}));
vi.mock("@/lib/sharedStore", () => ({
  readSharedStore: async () => ({ ...mocks.values }),
  setSharedStoreKey: async (store: string, key: string, value: unknown) => {
    mocks.write(store, key, value);
    mocks.values[key] = value;
  },
  onSharedStoreChange: async () => () => {},
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/controls/tooltip", () => ({
  Hint: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/modules/alpha/query", () => ({
  AlphaQueryProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/modules/alpha/components/AlphaServiceBoundary", () => ({
  AlphaServiceBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/modules/alpha/chart/scenes/ConfiguredMarketChartScene", () => ({
  ConfiguredMarketChartScene: ({ visible }: { visible: boolean }) => {
    useEffect(() => {
      mocks.mounts.chart++;
    }, []);
    mocks.visible.chart = visible;
    return <div data-chart />;
  },
}));
vi.mock("@/modules/alpha/scenes/BacktestResultsScene", () => ({
  BacktestResultsScene: ({ visible }: { visible: boolean }) => {
    useEffect(() => {
      mocks.mounts.backtests++;
    }, []);
    mocks.visible.backtests = visible;
    return <div data-backtests />;
  },
}));
vi.mock("@/modules/alpha/scenes/WatchlistScene", () => ({
  WatchlistScene: ({
    visible,
    onSelect,
  }: {
    visible: boolean;
    onSelect: (symbol: string) => void;
  }) => {
    mocks.visible.watchlist = visible;
    return (
      <button type="button" onClick={() => onSelect("600000.SSE")}>
        select-symbol
      </button>
    );
  },
}));
vi.mock("@/modules/alpha/scenes/SecurityDetailsScene", () => ({
  SecurityDetailsScene: ({ visible }: { visible: boolean }) => {
    mocks.visible.security = visible;
    return null;
  },
}));
vi.mock("@/modules/alpha/scenes/TaskMonitorScene", () => ({
  TaskMonitorScene: ({ visible }: { visible: boolean }) => {
    mocks.visible.tasks = visible;
    return null;
  },
}));

import { AlphaDeskPage } from "@/modules/alpha/pages/AlphaDeskPage";

let root: ReturnType<typeof createRoot> | undefined;
let client: QueryClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  client?.clear();
  vi.clearAllMocks();
});

it("切换视图和收起分区保留实例，隐藏页面暂停全部场景，偏好不覆盖工作台", async () => {
  mocks.values = {
    workstation: { mainSymbol: "000001.SZSE" },
    "desk.symbol": "000002.SZSE",
  };
  mocks.mounts = { chart: 0, backtests: 0 };
  const container = document.createElement("div");
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryClient = client;
  const render = (visible: boolean) =>
    root?.render(
      <QueryClientProvider client={queryClient}>
        <AlphaDeskPage visible={visible} />
      </QueryClientProvider>,
    );
  await act(async () => {
    render(true);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const chart = container.querySelector("[data-chart]");
  expect(chart).not.toBeNull();
  const click = async (label: string) => {
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find(
      (button) =>
        button.textContent === label ||
        button.getAttribute("aria-label") === label,
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  };
  await click("desk.backtests");
  expect(mocks.visible.chart).toBe(false);
  expect(mocks.visible.backtests).toBe(true);
  await click("desk.market");
  expect(container.querySelector("[data-chart]")).toBe(chart);
  expect(mocks.mounts).toEqual({ chart: 1, backtests: 1 });
  await click("desk.tasks");
  expect(mocks.visible.tasks).toBe(true);
  await click("desk.security");
  expect(mocks.visible.tasks).toBe(false);
  expect(mocks.visible.security).toBe(true);
  await click("select-symbol");
  expect(mocks.write).toHaveBeenCalledWith(
    "alpha",
    "desk.symbol",
    "600000.SSE",
  );
  expect(mocks.values.workstation).toEqual({ mainSymbol: "000001.SZSE" });
  await click("desk.watchlist");
  expect(mocks.visible.watchlist).toBe(false);
  expect(container.querySelector("[data-chart]")).toBe(chart);
  expect(mocks.mounts).toEqual({ chart: 1, backtests: 1 });
  await act(async () => render(false));
  expect(Object.values(mocks.visible).every((value) => !value)).toBe(true);
});

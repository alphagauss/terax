// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  write: vi.fn(),
  mounts: { chart: 0, backtests: 0, data: 0 },
  visible: {} as Record<string, boolean>,
  running: true,
  settingsMounts: 0,
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
  AlphaServiceBoundary: ({ children }: { children: ReactNode }) =>
    mocks.running ? children : <div data-service-stopped />,
}));
vi.mock("@/modules/alpha/components/AlphaSettingsDialog", () => ({
  AlphaSettingsDialog: ({
    open,
    visible,
    onOpenChange,
  }: {
    open: boolean;
    visible: boolean;
    onOpenChange: (open: boolean) => void;
  }) => {
    useEffect(() => {
      mocks.settingsMounts++;
    }, []);
    mocks.visible.settings = visible;
    return (
      <WorkbenchPageDialog
        open={open}
        title="settings"
        onOpenChange={onOpenChange}
      >
        <input data-settings-draft />
      </WorkbenchPageDialog>
    );
  },
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
vi.mock("@/modules/alpha/scenes/DataManagementScene", () => ({
  DataManagementScene: ({ visible }: { visible: boolean }) => {
    useEffect(() => {
      mocks.mounts.data++;
    }, []);
    mocks.visible.data = visible;
    return <input data-data-draft />;
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
import {
  WorkbenchPageDialog,
  WorkbenchPageScope,
} from "@/modules/workbench/WorkbenchPageOverlays";

let root: ReturnType<typeof createRoot> | undefined;
let client: QueryClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  client?.clear();
  vi.clearAllMocks();
  mocks.running = true;
  mocks.settingsMounts = 0;
  mocks.visible = {};
});

it("停服时设置入口仍可打开，切页和服务启停不卸载设置现场", async () => {
  mocks.running = false;
  mocks.values = {};
  const container = document.createElement("div");
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryClient = client;
  const render = async (visible: boolean) =>
    act(async () =>
      root?.render(
        <QueryClientProvider client={queryClient}>
          <WorkbenchPageScope visible={visible} focused={visible}>
            <AlphaDeskPage visible={visible} />
          </WorkbenchPageScope>
        </QueryClientProvider>,
      ),
    );
  await render(true);
  expect(container.querySelector("[data-service-stopped]")).not.toBeNull();
  const settings = container.querySelector<HTMLButtonElement>(
    'button[aria-label="desk.settings"]',
  );
  expect(settings).not.toBeNull();
  await act(async () => {
    settings?.click();
  });
  const draft = container.querySelector<HTMLInputElement>(
    "[data-settings-draft]",
  );
  if (!draft) throw new Error("Settings did not open");
  draft.value = "unsaved";
  expect(mocks.settingsMounts).toBe(1);
  await render(false);
  expect(mocks.visible.settings).toBe(false);
  await render(true);
  mocks.running = true;
  await render(true);
  mocks.running = false;
  await render(true);
  expect(container.querySelector("[data-settings-draft]")).toBe(draft);
  expect(draft.value).toBe("unsaved");
  expect(mocks.settingsMounts).toBe(1);
  const close = container.querySelector<HTMLButtonElement>(
    '[data-workbench-page-overlay="dialog"] button[aria-label="close"]',
  );
  await act(async () => close?.click());
  expect(
    container
      .querySelector('[data-workbench-page-overlay="dialog"]')
      ?.getAttribute("data-state"),
  ).toBe("closed");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
  expect(
    container.querySelector('[data-workbench-page-overlay="dialog"]'),
  ).toBeNull();
});

it("切换视图和收起分区保留实例，隐藏页面暂停全部场景，偏好不覆盖其他配置", async () => {
  mocks.values = {
    alphaShowInRemoteEnvironments: true,
    "desk.symbol": "000002.SZSE",
  };
  mocks.mounts = { chart: 0, backtests: 0, data: 0 };
  const container = document.createElement("div");
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryClient = client;
  const render = (visible: boolean) =>
    root?.render(
      <QueryClientProvider client={queryClient}>
        <WorkbenchPageScope visible={visible} focused={visible}>
          <AlphaDeskPage visible={visible} />
        </WorkbenchPageScope>
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
  const watchlist = container.querySelector<HTMLElement>(
    'aside[aria-label="desk.watchlist"]',
  );
  const details = container.querySelector<HTMLElement>('aside[id$="-details"]');
  expect(watchlist?.hasAttribute("inert")).toBe(false);
  expect(details?.hasAttribute("inert")).toBe(true);
  const leftTools = container.querySelector(
    'nav[aria-label="desk.watchlistTools"]',
  );
  const rightTools = container.querySelector('nav[aria-label="desk.tools"]');
  expect(
    leftTools?.querySelector('button[aria-label="desk.watchlist"]'),
  ).not.toBeNull();
  expect(
    rightTools?.querySelector('button[aria-label="desk.watchlist"]'),
  ).toBeNull();
  expect(
    rightTools?.querySelector('button[aria-label="desk.security"]'),
  ).not.toBeNull();
  expect(
    container.querySelectorAll('button[aria-label="desk.watchlist"]'),
  ).toHaveLength(1);
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
  await click("desk.data");
  expect(mocks.visible.backtests).toBe(false);
  expect(mocks.visible.data).toBe(true);
  const dataDraft =
    container.querySelector<HTMLInputElement>("[data-data-draft]");
  if (!dataDraft) throw new Error("Data management did not open");
  dataDraft.value = "saved search";
  await click("desk.market");
  expect(container.querySelector("[data-chart]")).toBe(chart);
  expect(container.querySelector("[data-data-draft]")).toBe(dataDraft);
  expect(dataDraft.value).toBe("saved search");
  expect(mocks.visible.data).toBe(false);
  expect(mocks.mounts).toEqual({ chart: 1, backtests: 1, data: 1 });
  await click("desk.tasks");
  expect(mocks.visible.tasks).toBe(true);
  expect(container.querySelector('aside[id$="-details"]')).toBe(details);
  expect(details?.hasAttribute("inert")).toBe(false);
  await click("desk.security");
  expect(mocks.visible.tasks).toBe(false);
  expect(mocks.visible.security).toBe(true);
  await click("select-symbol");
  expect(mocks.write).toHaveBeenCalledWith(
    "alpha",
    "desk.symbol",
    "600000.SSE",
  );
  expect(mocks.values.alphaShowInRemoteEnvironments).toBe(true);
  await click("desk.watchlist");
  expect(mocks.visible.watchlist).toBe(false);
  expect(container.querySelector('aside[aria-label="desk.watchlist"]')).toBe(
    watchlist,
  );
  expect(watchlist?.hasAttribute("inert")).toBe(true);
  expect(container.querySelector("[data-chart]")).toBe(chart);
  expect(mocks.mounts).toEqual({ chart: 1, backtests: 1, data: 1 });
  await click("desk.watchlist");
  expect(watchlist?.hasAttribute("inert")).toBe(false);
  await click("desk.security");
  expect(details?.hasAttribute("inert")).toBe(true);
  await click("desk.tasks");
  await click("desk.openTaskWindow");
  const taskWindow = container.querySelector(
    '[data-workbench-page-overlay="window"]',
  );
  expect(taskWindow).not.toBeNull();
  await act(async () => render(false));
  expect(Object.values(mocks.visible).every((value) => !value)).toBe(true);
  await act(async () => render(true));
  expect(
    container.querySelector('[data-workbench-page-overlay="window"]'),
  ).toBe(taskWindow);
});

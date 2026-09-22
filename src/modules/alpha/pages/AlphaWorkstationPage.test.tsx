/**
 * 本文件测试 Alpha 工作台页面对共享状态和多工作组挂载的连接。
 * 重点锁定页面操作和独立同步开关统一提交到共享 store，多个页面实例不会产生重复表单标识。
 */

// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateState: vi.fn(),
  state: null as AlphaWorkstationState | null,
  gridProps: null as Record<string, unknown> | null,
}));

vi.mock("@/components/menu/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) =>
    children,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
    children,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/modules/alpha/query", () => ({
  AlphaQueryProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/modules/alpha/workstation/components/AlphaPanelPool", () => ({
  AlphaPanelPool: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/modules/alpha/workstation/components/AlphaPanelGrid", () => ({
  AlphaPanelGrid: (props: Record<string, unknown>) => {
    mocks.gridProps = props;
    return null;
  },
}));

vi.mock("@/modules/alpha/workstation/store", async () => {
  const templates = await import("@/modules/alpha/workstation/templates");
  return {
    useAlphaWorkstationSnapshot: () => ({
      hydrated: true,
      state: mocks.state ?? templates.createDefaultAlphaWorkstationState(),
    }),
    updateAlphaWorkstationState: mocks.updateState,
  };
});

import { AlphaWorkstationPage } from "@/modules/alpha/pages/AlphaWorkstationPage";
import type { AlphaWorkstationState } from "@/modules/alpha/workstation/model";
import { createDefaultAlphaWorkstationState } from "@/modules/alpha/workstation/templates";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

describe("AlphaWorkstationPage", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    root = createRoot(container);
    mocks.state = null;
    mocks.gridProps = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.clearAllMocks();
  });

  it("切换布局锁时统一更新共享工作台状态", async () => {
    await act(async () => {
      root?.render(<AlphaWorkstationPage visible />);
    });

    const lockButton = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.includes("workstation.lock"));
    act(() => lockButton?.click());

    expect(mocks.updateState).toHaveBeenCalledTimes(1);
    const [update] = mocks.updateState.mock.calls[0] as [
      (state: AlphaWorkstationState) => AlphaWorkstationState,
    ];
    expect(update(createDefaultAlphaWorkstationState()).locked).toBe(true);
  });

  it("分别切换范围和十字线同步配置", async () => {
    await act(async () => {
      root?.render(<AlphaWorkstationPage visible />);
    });

    const rangeButton = container.querySelector<HTMLButtonElement>(
      "[data-alpha-chart-range-sync]",
    );
    const crosshairButton = container.querySelector<HTMLButtonElement>(
      "[data-alpha-chart-crosshair-sync]",
    );
    act(() => rangeButton?.click());
    act(() => crosshairButton?.click());

    expect(mocks.updateState).toHaveBeenCalledTimes(2);
    const initial = createDefaultAlphaWorkstationState();
    const [rangeUpdate] = mocks.updateState.mock.calls[0] as [
      (state: AlphaWorkstationState) => AlphaWorkstationState,
    ];
    const [crosshairUpdate] = mocks.updateState.mock.calls[1] as [
      (state: AlphaWorkstationState) => AlphaWorkstationState,
    ];
    expect(rangeUpdate(initial).chartSync).toEqual({
      ...initial.chartSync,
      rangeEnabled: true,
    });
    expect(crosshairUpdate(initial).chartSync).toEqual({
      ...initial.chartSync,
      crosshairEnabled: true,
    });
  });

  it("多个工作组同时挂载工作台时使用独立的表单标识", async () => {
    await act(async () => {
      root?.render(
        <>
          <AlphaWorkstationPage visible />
          <AlphaWorkstationPage visible={false} />
        </>,
      );
    });

    const inputs = [...container.querySelectorAll<HTMLInputElement>("input")];
    expect(inputs).toHaveLength(2);
    expect(new Set(inputs.map((input) => input.id)).size).toBe(2);
  });

  it("面板菜单区分重复项，找回时只置顶并请求定位，保持折叠和几何", async () => {
    const state = createDefaultAlphaWorkstationState();
    const first = state.layout.panels[0];
    first.collapsed = true;
    state.layout.panels.push({ ...first, id: "second", collapsed: false });
    state.layout.grid.push({ ...state.layout.grid[0], panelId: "second" });
    mocks.state = state;
    await act(async () => root?.render(<AlphaWorkstationPage visible />));
    const entries = [...container.querySelectorAll("button")].filter((button) =>
      button.textContent?.includes("workstation.panels.chart ·"),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].textContent).toContain("(1)");
    expect(entries[1].textContent).toContain("(2)");
    act(() => entries[0].click());
    const update = mocks.updateState.mock.calls[0][0] as (
      state: AlphaWorkstationState,
    ) => AlphaWorkstationState;
    const next = update(state);
    expect(next.layout.panels).toBe(state.layout.panels);
    expect(next.layout.grid).toEqual([
      state.layout.grid[1],
      state.layout.grid[0],
    ]);
    expect(next.layout.panels[0].collapsed).toBe(true);
    expect(mocks.gridProps?.revealRequest).toEqual({ panelId: first.id });
  });
});

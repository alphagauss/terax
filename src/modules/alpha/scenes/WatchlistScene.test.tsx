// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({
  items: [] as Array<{
    group_id: string;
    vt_symbol: string;
    name: string;
    position: number;
    pinned: boolean;
    pin_position: number;
    price_tick: number | null;
  }>,
  change: vi.fn(),
  search: vi.fn(async ({ offset }: { offset: number }) => ({
    items: [{ vt_symbol: `${offset}.SSE`, name: `证券 ${offset}` }],
    total: 31,
  })),
}));
vi.mock("@/modules/alpha/api", () => ({
  getAlphaSecurities: mocks.search,
}));
vi.mock("@/modules/alpha/watchlist/api", () => ({
  getWatchlist: async () => ({ groups: [], items: mocks.items }),
  getWatchlistQuotes: async () =>
    mocks.items.map((item, index) => ({
      vt_symbol: item.vt_symbol,
      close: index + 10,
      change: index,
      date: "2026-09-22",
      closes: [9, 10],
      price_tick: 0.01,
      price_color_convention: "up-red",
      status: "daily",
    })),
  changeWatchlist: mocks.change,
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 52,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 52,
        size: 52,
      })),
  }),
}));
vi.mock("@/components/controls/tooltip", () => ({
  Hint: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

import { WatchlistScene } from "@/modules/alpha/scenes/WatchlistScene";
import { WorkbenchPageScope } from "@/modules/workbench/WorkbenchPageOverlays";

it("搜索浮窗保留自选列表，支持分页、重新搜索及添加证券", async () => {
  mocks.change.mockImplementation(async (command) => {
    mocks.items = [
      {
        group_id: command.group_id,
        vt_symbol: command.symbols[0],
        name: "证券 0",
        position: 0,
        pinned: false,
        pin_position: 0,
        price_tick: 0.01,
      },
    ];
    return { groups: [], items: mocks.items };
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <WorkbenchPageScope visible focused>
            <WatchlistScene visible symbol="000001.SZSE" onSelect={() => {}} />
          </WorkbenchPageScope>
        </QueryClientProvider>,
      ),
    );
    await settle();
    expect(container.querySelector("input")).toBeNull();
    const table = container.querySelector(".alpha-watchlist-columns");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="watch.searchAdd"]',
        )
        ?.click(),
    );
    const input = container.querySelector("input");
    const form = container.querySelector("form");
    if (!input || !form) throw new Error("missing search form");
    const search = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      await settle();
    };
    await search("银行");
    expect(container.querySelector(".alpha-watchlist-columns")).toBe(table);
    expect(container.querySelector('[role="dialog"]')?.contains(input)).toBe(
      true,
    );
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "desk.next")
        ?.click();
    });
    await settle();
    expect(mocks.search).toHaveBeenLastCalledWith({
      q: "银行",
      limit: 30,
      offset: 30,
    });
    expect(container.textContent).toContain("证券 30");
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "desk.next",
      )?.disabled,
    ).toBe(true);
    await search("证券");
    expect(mocks.search).toHaveBeenLastCalledWith({
      q: "证券",
      limit: 30,
      offset: 0,
    });
    await act(async () =>
      [
        ...container.querySelectorAll<HTMLButtonElement>(
          '[role="dialog"] button',
        ),
      ]
        .find((button) => button.textContent === "desk.add")
        ?.click(),
    );
    await settle();
    expect(mocks.change).toHaveBeenCalledWith(
      { action: "add", group_id: "all", symbols: ["0.SSE"] },
      expect.anything(),
    );
    expect(
      container.querySelector('[data-watchlist-symbol="0.SSE"]'),
    ).not.toBeNull();
    expect(
      [
        ...container.querySelectorAll<HTMLButtonElement>(
          '[role="dialog"] button',
        ),
      ].find((button) => button.textContent === "watch.added")?.disabled,
    ).toBe(true);
    await act(async () =>
      container
        .querySelector('[role="dialog"]')
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
    );
    expect(
      container
        .querySelector('button[aria-label="watch.searchAdd"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(container.querySelector(".alpha-watchlist-columns")).toBe(table);
  } finally {
    act(() => root.unmount());
    client.clear();
    mocks.items = [];
    mocks.change.mockReset();
  }
});

it("多选隔离主图与排序操作，逐项及范围勾选只提交批量成员命令", async () => {
  mocks.items = ["A", "B", "C"].map((name, position) => ({
    name,
    vt_symbol: `${name}.SSE`,
    group_id: "all",
    position,
    pinned: name === "A",
    pin_position: 0,
    price_tick: 0.01,
  }));
  mocks.change.mockImplementation(async (command) => {
    mocks.items = mocks.items.filter(
      (item) => !command.symbols.includes(item.vt_symbol),
    );
    const committed = { groups: [], items: [...mocks.items] };
    // 模拟其他窗口在本次提交后新增证券，延迟返回的写入快照不包含该成员。
    mocks.items.push({
      name: "D",
      vt_symbol: "D.SSE",
      group_id: "all",
      position: 3,
      pinned: false,
      pin_position: 0,
      price_tick: 0.01,
    });
    return committed;
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onSelect = vi.fn();
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  const button = (text: string) => {
    const element = [...container.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === text,
    );
    if (!element) throw new Error(`Missing button ${text}`);
    return element;
  };
  const row = (name: string) => {
    const element = container.querySelector<HTMLElement>(
      `[role="group"][aria-label="${name}"]`,
    );
    if (!element) throw new Error(`Missing row ${name}`);
    return element;
  };
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <WorkbenchPageScope visible focused>
            <WatchlistScene visible symbol="A.SSE" onSelect={onSelect} />
          </WorkbenchPageScope>
        </QueryClientProvider>,
      ),
    );
    await settle();
    await settle();
    await act(async () => button("watch.change").click());
    expect(
      [...container.querySelectorAll('[role="group"]')].map((node) =>
        node.getAttribute("aria-label"),
      ),
    ).toEqual(["C", "B", "A"]);
    expect(mocks.change).not.toHaveBeenCalled();
    await act(async () => button("watch.multi").click());
    expect(button("watch.cancelSort").disabled).toBe(true);
    expect(button("watch.change ↓").disabled).toBe(true);
    expect(row("A").hasAttribute("draggable")).toBe(false);
    await act(async () =>
      row("C")
        .querySelector<HTMLButtonElement>("button[aria-pressed]")
        ?.click(),
    );
    await act(async () =>
      row("A")
        .querySelector<HTMLButtonElement>("button[aria-pressed]")
        ?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, shiftKey: true }),
        ),
    );
    expect(onSelect).not.toHaveBeenCalled();
    expect(
      container.querySelectorAll('[role="checkbox"][aria-checked="true"]'),
    ).toHaveLength(4);
    await act(async () => button("watch.removeAll").click());
    await settle();
    expect(mocks.change).toHaveBeenLastCalledWith(
      {
        action: "remove",
        group_id: "all",
        symbols: ["C.SSE", "B.SSE", "A.SSE"],
      },
      expect.anything(),
    );
    expect(button("watch.removeAll").disabled).toBe(true);
    expect(row("D")).toBeTruthy();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(
      client.getQueryData<{ items: unknown[] }>(["alpha", "watchlist"])?.items,
    ).toHaveLength(1);
    await act(async () => button("watch.done").click());
    expect(button("watch.cancelSort").disabled).toBe(false);
  } finally {
    act(() => root.unmount());
    client.clear();
    container.remove();
    mocks.items = [];
    mocks.change.mockReset();
  }
});

it("拖动使用同区域相邻锚点，不跨越置顶边界或切换主图", async () => {
  mocks.items = ["A", "B", "C"].map((name, position) => ({
    name,
    vt_symbol: `${name}.SSE`,
    group_id: "all",
    position,
    pinned: name === "A",
    pin_position: 0,
    price_tick: 0.01,
  }));
  let finishSave: (() => void) | undefined;
  mocks.change.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishSave = () => resolve({ groups: [], items: mocks.items });
      }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  const onSelect = vi.fn();
  const row = (name: string) =>
    container.querySelector<HTMLElement>(
      `[role="group"][aria-label="${name}"]`,
    );
  const capture = new Set<number>();
  const fire = async (name: string, type: string, y = 110) => {
    await act(async () => {
      row(name)?.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: "mouse",
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: 30,
          clientY: y,
        }),
      );
    });
  };
  let hit: HTMLElement | null = null;
  const hitTest = vi
    .spyOn(document, "elementFromPoint")
    .mockImplementation(() => hit);
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <WorkbenchPageScope visible focused>
            <WatchlistScene visible symbol="A.SSE" onSelect={onSelect} />
          </WorkbenchPageScope>
        </QueryClientProvider>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const host = row("B")?.closest<HTMLDivElement>(".app-scrollbar");
    if (!host) throw new Error("missing viewport");
    host.setPointerCapture = (id) => {
      capture.add(id);
    };
    host.hasPointerCapture = (id) => capture.has(id);
    host.releasePointerCapture = (id) => {
      capture.delete(id);
    };
    host.getBoundingClientRect = () => ({
      top: 0,
      bottom: 300,
      left: 0,
      right: 360,
      width: 360,
      height: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const overlay = container.querySelector<HTMLElement>(
      "[data-workbench-overlay-host]",
    );
    if (!overlay) throw new Error("missing overlay host");
    overlay.getBoundingClientRect = host.getBoundingClientRect;
    const preview = () =>
      overlay.querySelector<HTMLElement>(".alpha-watchlist-drag-preview");
    for (const name of ["A", "B", "C"]) {
      const element = row(name);
      if (element)
        element.getBoundingClientRect = () => ({
          top: 140,
          bottom: 192,
          left: 0,
          right: 360,
          width: 360,
          height: 52,
          x: 0,
          y: 140,
          toJSON: () => ({}),
        });
    }
    await fire("B", "pointerdown");
    await fire("B", "pointermove", 112);
    expect(capture.size).toBe(0);
    expect(preview()).toBeNull();
    await fire("B", "pointerup", 112);
    hit = row("A");
    await fire("B", "pointerdown");
    await fire("B", "pointermove", 145);
    expect(preview()?.textContent).toContain("B.SSE");
    expect(preview()?.getAttribute("aria-hidden")).toBe("true");
    expect(preview()?.dataset.allowed).toBe("false");
    await fire("B", "pointerup", 145);
    expect(preview()).toBeNull();
    expect(mocks.change).not.toHaveBeenCalled();
    hit = row("C");
    await fire("B", "pointerdown");
    await fire("B", "pointermove", 145);
    expect(capture.has(1)).toBe(true);
    const card = preview();
    expect(card?.dataset.allowed).toBe("true");
    const position = card?.style.transform;
    await fire("B", "pointermove", 150);
    expect(preview()).toBe(card);
    expect(card?.style.transform).not.toBe(position);
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    expect(capture.size).toBe(0);
    expect(preview()).toBeNull();
    expect(mocks.change).not.toHaveBeenCalled();
    await fire("B", "pointerdown");
    await fire("B", "pointermove", 145);
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(preview()).toBeNull();
    expect(capture.size).toBe(0);
    expect(mocks.change).not.toHaveBeenCalled();
    await fire("B", "pointerdown");
    await fire("B", "pointermove", 145);
    await fire("B", "pointerup", 145);
    expect(preview()).toBeNull();
    await act(async () =>
      row("B")
        ?.querySelector<HTMLButtonElement>("button[aria-pressed]")
        ?.click(),
    );
    expect(mocks.change).toHaveBeenCalledWith(
      {
        action: "reorder",
        group_id: "all",
        symbols: ["B.SSE"],
        anchor: "C.SSE",
        side: "before",
      },
      expect.anything(),
    );
    expect(onSelect).not.toHaveBeenCalled();
    const toolbar = container.querySelector<HTMLElement>('[aria-busy="true"]');
    expect(toolbar?.hasAttribute("inert")).toBe(true);
    const controls = [
      ...(toolbar?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ];
    expect(controls.length).toBeGreaterThanOrEqual(4);
    expect(controls.every((button) => !button.disabled)).toBe(true);
    const header = container.querySelector<HTMLElement>(
      ".alpha-watchlist-columns.sticky",
    );
    expect(header?.hasAttribute("inert")).toBe(true);
    const sortButton = [
      ...(header?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ].find((button) => button.textContent === "watch.change");
    expect(sortButton?.disabled).toBe(false);
    if (!finishSave) throw new Error("missing pending save");
    await act(async () => finishSave?.());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(toolbar?.hasAttribute("inert")).toBe(false);
    expect(header?.hasAttribute("inert")).toBe(false);
    expect(sortButton?.disabled).toBe(false);
    expect(container.querySelector('[role="status"]')).toBeNull();
    mocks.change.mockRejectedValueOnce(new Error("save_failed"));
    await fire("B", "pointerdown");
    await fire("B", "pointermove", 145);
    await fire("B", "pointerup", 145);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "watch.errors.save_failed",
    );
    expect(toolbar?.hasAttribute("inert")).toBe(false);
  } finally {
    hitTest.mockRestore();
    act(() => root.unmount());
    client.clear();
    mocks.items = [];
    mocks.change.mockReset();
  }
});

// @vitest-environment happy-dom

/**
 * 本文件测试启动页面预热的候选快照与优先级。
 * 重点锁定只预热支持的冷页面、当前 Space 优先，以及串行空闲调度时序。
 */

import type { Tab, WorkbenchState } from "@/modules/workbench/types";
import {
  STARTUP_WARMUP_GAP_MS,
  collectStartupWarmupIds,
  pickNextStartupWarmupTab,
  useStartupWarmup,
} from "@/modules/workbench/useStartupWarmup";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warmupMocks = vi.hoisted(() => ({
  whenSessionReady: vi.fn(),
}));

vi.mock("@/modules/terminal", () => ({
  whenSessionReady: warmupMocks.whenSessionReady,
}));

function stateWith(tabs: Tab[]): WorkbenchState {
  return {
    tabs: Object.fromEntries(tabs.map((tab) => [tab.id, tab])),
    spaces: {},
  };
}

type HarnessProps = {
  state: WorkbenchState;
  activeTab?: Tab;
  warm: (id: number) => void;
};

/** 挂载启动预热 Hook，供测试驱动空闲回调和前台就绪时序。 */
function Harness({ state, activeTab, warm }: HarnessProps) {
  useStartupWarmup({
    enabled: true,
    state,
    activeSpaceId: "a",
    activeTab,
    warmTabInBackground: warm,
  });
  return null;
}

describe("startup warmup selection", () => {
  it("只收集冷终端、编辑器和 Markdown", () => {
    const state = stateWith([
      { id: 1, kind: "terminal", spaceId: "a", title: "shell", cold: true },
      {
        id: 2,
        kind: "editor",
        spaceId: "a",
        title: "a.ts",
        path: "/a.ts",
        dirty: false,
        preview: false,
        cold: true,
      },
      {
        id: 3,
        kind: "markdown",
        spaceId: "a",
        title: "README.md",
        path: "/README.md",
        dirty: false,
        preview: false,
        cold: true,
      },
      {
        id: 4,
        kind: "web-preview",
        spaceId: "a",
        title: "Preview",
        url: "http://localhost:3000",
        cold: true,
      },
      { id: 5, kind: "alpha-data", spaceId: "a", title: "Alpha", cold: true },
      { id: 6, kind: "terminal", spaceId: "a", title: "warm" },
    ]);

    expect([...collectStartupWarmupIds(state)]).toEqual([1, 2, 3]);
  });

  it("优先当前 Space，并按终端、编辑器和 Markdown 排序", () => {
    const state = stateWith([
      {
        id: 1,
        kind: "markdown",
        spaceId: "current",
        title: "README.md",
        path: "/README.md",
        dirty: false,
        preview: false,
        cold: true,
      },
      { id: 2, kind: "terminal", spaceId: "other", title: "other", cold: true },
      {
        id: 3,
        kind: "editor",
        spaceId: "current",
        title: "a.ts",
        path: "/a.ts",
        dirty: false,
        preview: false,
        cold: true,
      },
      {
        id: 4,
        kind: "terminal",
        spaceId: "current",
        title: "shell",
        cold: true,
      },
    ]);
    const pending = collectStartupWarmupIds(state);

    expect(pickNextStartupWarmupTab(state, "current", pending)?.id).toBe(4);
    pending.delete(4);
    expect(pickNextStartupWarmupTab(state, "current", pending)?.id).toBe(3);
    pending.delete(3);
    expect(pickNextStartupWarmupTab(state, "current", pending)?.id).toBe(1);
    pending.delete(1);
    expect(pickNextStartupWarmupTab(state, "current", pending)?.id).toBe(2);
  });

  it("跳过已被用户激活或已经关闭的启动候选", () => {
    const original = stateWith([
      { id: 1, kind: "terminal", spaceId: "a", title: "one", cold: true },
      { id: 2, kind: "terminal", spaceId: "a", title: "two", cold: true },
    ]);
    const pending = collectStartupWarmupIds(original);
    const current = stateWith([
      { id: 1, kind: "terminal", spaceId: "a", title: "one", cold: false },
    ]);

    expect(pickNextStartupWarmupTab(current, "a", pending)).toBeNull();
  });
});

describe("startup warmup scheduling", () => {
  type IdleEntry = { callback: IdleRequestCallback };
  let root: Root;
  let idleEntries: Map<number, IdleEntry>;
  let nextIdleId: number;

  beforeEach(() => {
    vi.useFakeTimers();
    idleEntries = new Map();
    nextIdleId = 1;
    warmupMocks.whenSessionReady.mockReset();
    warmupMocks.whenSessionReady.mockResolvedValue(undefined);
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: IdleRequestCallback) => {
        const id = nextIdleId++;
        idleEntries.set(id, { callback });
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelIdleCallback",
      vi.fn((id: number) => idleEntries.delete(id)),
    );
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function runNextIdle() {
    const entry = idleEntries.entries().next().value as
      | [number, IdleEntry]
      | undefined;
    if (!entry) throw new Error("没有待执行的空闲回调");
    idleEntries.delete(entry[0]);
    act(() =>
      entry[1].callback({ didTimeout: false, timeRemaining: () => 10 }),
    );
  }

  it("每个空闲轮次只挂载一个页面并保留间隔", async () => {
    const state = stateWith([
      { id: 1, kind: "terminal", spaceId: "a", title: "shell", cold: true },
      {
        id: 2,
        kind: "editor",
        spaceId: "a",
        title: "a.ts",
        path: "/a.ts",
        dirty: false,
        preview: false,
        cold: true,
      },
      {
        id: 3,
        kind: "web-preview",
        spaceId: "a",
        title: "Preview",
        url: "http://localhost:3000",
        cold: true,
      },
    ]);
    const warm = vi.fn();
    await act(async () => {
      root.render(createElement(Harness, { state, warm }));
    });

    expect(idleEntries.size).toBe(1);
    runNextIdle();
    expect(warm).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenLastCalledWith(1);
    expect(idleEntries.size).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_WARMUP_GAP_MS);
    });
    expect(idleEntries.size).toBe(1);
    runNextIdle();
    expect(warm).toHaveBeenCalledTimes(2);
    expect(warm).toHaveBeenLastCalledWith(2);
  });

  it("活动终端就绪后才开始后台预热", async () => {
    let markReady: (() => void) | undefined;
    warmupMocks.whenSessionReady.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        markReady = resolve;
      }),
    );
    const activeTab: Tab = {
      id: 9,
      kind: "terminal",
      spaceId: "a",
      title: "active",
    };
    const state = stateWith([
      activeTab,
      { id: 1, kind: "terminal", spaceId: "a", title: "cold", cold: true },
    ]);

    await act(async () => {
      root.render(createElement(Harness, { state, activeTab, warm: vi.fn() }));
    });
    expect(warmupMocks.whenSessionReady).toHaveBeenCalledWith(9);
    expect(idleEntries.size).toBe(0);

    await act(async () => markReady?.());
    expect(idleEntries.size).toBe(1);
  });
});

/**
 * 本文件测试 Alpha 工作台共享配置的加载、等价窗口写入和失败恢复。
 * 重点锁定监听失败不覆盖已读状态，且 `workstation` 单键只保存最新完整状态。
 */

// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  readSharedStore: vi.fn(),
  setSharedStoreKey: vi.fn(),
  onSharedStoreChange: vi.fn(),
}));

vi.mock("@/lib/sharedStore", () => ({
  readSharedStore: mocks.readSharedStore,
  setSharedStoreKey: mocks.setSharedStoreKey,
  onSharedStoreChange: mocks.onSharedStoreChange,
}));

import type { AlphaWorkstationSnapshot } from "@/modules/alpha/workstation/store";
import {
  flushAlphaWorkstationWrites,
  resetAlphaWorkstationStoreForTests,
  updateAlphaWorkstationState,
  useAlphaWorkstationSnapshot,
} from "@/modules/alpha/workstation/store";
import { createDefaultAlphaWorkstationState } from "@/modules/alpha/workstation/templates";

function Probe({
  onSnapshot,
}: {
  onSnapshot: (value: AlphaWorkstationSnapshot) => void;
}) {
  const snapshot = useAlphaWorkstationSnapshot();
  useEffect(() => {
    onSnapshot(snapshot);
  }, [onSnapshot, snapshot]);
  return null;
}

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

describe("Alpha workstation shared store", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    mocks.values = {};
    mocks.readSharedStore.mockImplementation(async () => mocks.values);
    mocks.setSharedStoreKey.mockResolvedValue(undefined);
    mocks.onSharedStoreChange.mockImplementation(
      async (_store: string, callback: () => Promise<void>) => {
        await callback();
        return () => undefined;
      },
    );
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    resetAlphaWorkstationStoreForTests();
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("加载有效共享状态并归一化标的", async () => {
    mocks.values = {
      workstation: {
        ...createDefaultAlphaWorkstationState(),
        mainSymbol: "600000.sse",
      },
    };
    let latest: AlphaWorkstationSnapshot | null = null;

    await act(async () => {
      root?.render(<Probe onSnapshot={(value) => (latest = value)} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest).toMatchObject({
      hydrated: true,
      state: { mainSymbol: "600000.SSE" },
    });
  });

  it("监听注册失败时保留已经读取的共享状态", async () => {
    mocks.values = {
      workstation: {
        ...createDefaultAlphaWorkstationState(),
        mainSymbol: "600000.SSE",
      },
    };
    mocks.onSharedStoreChange.mockRejectedValueOnce(new Error("listen failed"));
    let latest: AlphaWorkstationSnapshot | null = null;

    await act(async () => {
      root?.render(<Probe onSnapshot={(value) => (latest = value)} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest).toMatchObject({
      hydrated: true,
      state: { mainSymbol: "600000.SSE" },
    });
  });

  it("任意窗口更新都会写入共享配置", async () => {
    await act(async () => {
      root?.render(<Probe onSnapshot={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      updateAlphaWorkstationState((state) => ({
        ...state,
        mainSymbol: "600000.SSE",
      }));
      vi.advanceTimersByTime(500);
    });
    await flushAlphaWorkstationWrites();

    expect(mocks.setSharedStoreKey).toHaveBeenCalledWith(
      "alpha",
      "workstation",
      expect.objectContaining({ mainSymbol: "600000.SSE" }),
    );
  });

  it("合并连续更新并只写入最新完整状态", async () => {
    await act(async () => {
      root?.render(<Probe onSnapshot={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      updateAlphaWorkstationState((state) => ({
        ...state,
        mainSymbol: "600000.SSE",
      }));
      updateAlphaWorkstationState((state) => ({ ...state, locked: true }));
      vi.advanceTimersByTime(200);
    });
    await flushAlphaWorkstationWrites();

    expect(mocks.setSharedStoreKey).toHaveBeenCalledTimes(1);
    expect(mocks.setSharedStoreKey).toHaveBeenCalledWith(
      "alpha",
      "workstation",
      expect.objectContaining({ mainSymbol: "600000.SSE", locked: true }),
    );
  });

  it("写入失败后保留最新状态供下一次 flush 重试", async () => {
    await act(async () => {
      root?.render(<Probe onSnapshot={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    mocks.setSharedStoreKey.mockRejectedValueOnce(new Error("busy"));
    updateAlphaWorkstationState((state) => ({
      ...state,
      mainSymbol: "600000.SSE",
    }));

    await expect(flushAlphaWorkstationWrites()).rejects.toThrow("busy");
    mocks.setSharedStoreKey.mockResolvedValue(undefined);
    await flushAlphaWorkstationWrites();

    expect(mocks.setSharedStoreKey).toHaveBeenCalledTimes(2);
    expect(mocks.setSharedStoreKey).toHaveBeenLastCalledWith(
      "alpha",
      "workstation",
      expect.objectContaining({ mainSymbol: "600000.SSE" }),
    );
  });
});

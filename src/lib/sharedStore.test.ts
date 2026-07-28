/**
 * 本文件测试跨进程共享存储的订阅与关闭前写入屏障。
 *
 * 订阅必须避免基线竞态，关闭刷新必须等待已经发出的原子写入完成。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listener: null as null | ((event: { payload: { store: string } }) => void),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (
      _event: string,
      listener: (event: { payload: { store: string } }) => void,
    ) => {
      mocks.listener = listener;
      return mocks.unlisten;
    },
  ),
}));

import {
  flushSharedStoreWrites,
  onSharedStoreChange,
  setSharedStoreKey,
} from "./sharedStore";

describe("shared store revision subscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.listener = null;
    const events = new EventTarget();
    vi.stubGlobal(
      "window",
      Object.assign(events, {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reloads once after subscribing so the baseline race cannot go stale", async () => {
    mocks.invoke.mockResolvedValue("r1");
    const callback = vi.fn();

    const dispose = await onSharedStoreChange("settings", callback);

    expect(callback).toHaveBeenCalledOnce();
    dispose();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it("coalesces rapid events and reads the final revision", async () => {
    let revision = "r1";
    mocks.invoke.mockImplementation(async () => revision);
    const callback = vi.fn();
    const dispose = await onSharedStoreChange("settings", callback);
    callback.mockClear();

    revision = "r2";
    mocks.listener?.({ payload: { store: "settings" } });
    revision = "r3";
    mocks.listener?.({ payload: { store: "settings" } });
    await vi.advanceTimersByTimeAsync(100);

    expect(callback).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenLastCalledWith("shared_store_revision", {
      store: "settings",
    });
    dispose();
  });

  it("keeps the listener active when the initial refresh fails", async () => {
    mocks.invoke.mockResolvedValue("r1");
    const callback = vi
      .fn()
      .mockRejectedValueOnce(new Error("reload failed"))
      .mockResolvedValue(undefined);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const dispose = await onSharedStoreChange("settings", callback);
    mocks.listener?.({ payload: { store: "settings" } });
    await vi.advanceTimersByTimeAsync(100);

    expect(callback).toHaveBeenCalledTimes(2);
    expect(mocks.unlisten).not.toHaveBeenCalled();
    dispose();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it("关闭刷新会等待所有在途共享存储写入", async () => {
    let releaseWrite: (() => void) | undefined;
    mocks.invoke.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseWrite = resolve;
      }),
    );
    const writing = setSharedStoreKey("ui-layout", "sidebar", {
      primary: [],
    });
    let flushed = false;
    const flushing = flushSharedStoreWrites().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    releaseWrite?.();
    await writing;
    await flushing;
    expect(flushed).toBe(true);
  });
});

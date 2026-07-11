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

import { onSharedStoreChange } from "./sharedStore";

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
});

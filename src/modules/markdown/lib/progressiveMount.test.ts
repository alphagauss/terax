import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProgressiveMountController,
  startProgressiveMounting,
} from "./progressiveMount";

describe("ProgressiveMountController", () => {
  it("starts with a bounded initial prefix and advances monotonically", () => {
    const controller = new ProgressiveMountController(5, 2);

    expect([0, 1, 2, 3, 4].map((index) => controller.isMounted(index))).toEqual(
      [true, true, false, false, false],
    );
    expect(controller.nextUnmountedIndex).toBe(2);
    expect(controller.allMounted).toBe(false);

    expect(controller.mount(4)).toBe(true);
    expect(controller.nextUnmountedIndex).toBe(2);
    expect(controller.mountNextBatch(2)).toBe(2);
    expect(controller.nextUnmountedIndex).toBeNull();
    expect(controller.allMounted).toBe(true);
  });

  it("notifies only listeners for indices that actually change", () => {
    const controller = new ProgressiveMountController(4, 1);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = controller.subscribe(1, first);
    controller.subscribe(2, second);

    expect(controller.mount(0)).toBe(false);
    expect(controller.mount(1)).toBe(true);
    expect(controller.mount(1)).toBe(false);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();

    unsubscribe();
    controller.mount(2);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("mounts a bounded range around a block", () => {
    const controller = new ProgressiveMountController(6, 0);
    const listeners = Array.from({ length: 6 }, () => vi.fn());
    listeners.forEach((listener, index) => {
      controller.subscribe(index, listener);
    });

    expect(controller.mountAround(2, 2)).toBe(5);
    expect(
      [0, 1, 2, 3, 4, 5].map((index) => controller.isMounted(index)),
    ).toEqual([true, true, true, true, true, false]);
    expect(listeners.map((listener) => listener.mock.calls.length)).toEqual([
      1, 1, 1, 1, 1, 0,
    ]);
    expect(controller.mountAround(0, 10)).toBe(1);
    expect(controller.allMounted).toBe(true);
  });

  it("handles invalid counts and indices without changing state", () => {
    const controller = new ProgressiveMountController(3.9, -2);
    const listener = vi.fn();

    expect(controller.blockCount).toBe(3);
    expect(controller.isMounted(-1)).toBe(false);
    expect(controller.isMounted(1.5)).toBe(false);
    expect(controller.mount(-1)).toBe(false);
    expect(controller.mount(3)).toBe(false);
    expect(controller.mountAround(4, 2)).toBe(0);
    expect(controller.mountNextBatch(0)).toBe(0);
    expect(controller.subscribe(5, listener)).toBeTypeOf("function");
    expect(listener).not.toHaveBeenCalled();
    expect(controller.nextUnmountedIndex).toBe(0);
  });

  it("stops mounting and notifying after disposal", () => {
    const controller = new ProgressiveMountController(3, 1);
    const listener = vi.fn();
    controller.subscribe(1, listener);

    controller.dispose();

    expect(controller.mount(1)).toBe(false);
    expect(controller.mountAround(1, 1)).toBe(0);
    expect(controller.mountNextBatch(2)).toBe(0);
    expect(controller.isMounted(1)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("startProgressiveMounting", () => {
  type IdleEntry = {
    callback: IdleRequestCallback;
    options?: IdleRequestOptions;
  };

  let idleEntries: Map<number, IdleEntry>;
  let nextIdleId: number;
  let requestIdle: ReturnType<typeof vi.fn>;
  let cancelIdle: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    idleEntries = new Map();
    nextIdleId = 1;
    requestIdle = vi.fn(
      (callback: IdleRequestCallback, options?: IdleRequestOptions) => {
        const id = nextIdleId++;
        idleEntries.set(id, { callback, options });
        return id;
      },
    );
    cancelIdle = vi.fn((id: number) => idleEntries.delete(id));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const installIdleCallbacks = () => {
    vi.stubGlobal("requestIdleCallback", requestIdle);
    vi.stubGlobal("cancelIdleCallback", cancelIdle);
  };

  const runIdle = (id: number, didTimeout: boolean, budget: number) => {
    const entry = idleEntries.get(id);
    if (!entry) throw new Error(`Idle callback ${id} was not scheduled`);
    idleEntries.delete(id);
    entry.callback({
      didTimeout,
      timeRemaining: () => budget,
    });
  };

  it("does not schedule when inactive or already complete", () => {
    installIdleCallbacks();

    const stopInactive = startProgressiveMounting(
      new ProgressiveMountController(5, 1),
      { active: false, batchSize: 2, timeout: 100 },
    );
    const stopComplete = startProgressiveMounting(
      new ProgressiveMountController(1, 1),
      { active: true, batchSize: 2, timeout: 100 },
    );

    expect(requestIdle).not.toHaveBeenCalled();
    stopInactive();
    stopComplete();
  });

  it("uses idle budget to mount one batch per round", () => {
    installIdleCallbacks();
    const controller = new ProgressiveMountController(6, 1);
    const stop = startProgressiveMounting(controller, {
      active: true,
      batchSize: 2,
      timeout: 75,
    });

    expect(requestIdle).toHaveBeenCalledOnce();
    expect(idleEntries.get(1)?.options).toEqual({ timeout: 75 });
    runIdle(1, false, 5);
    expect(controller.nextUnmountedIndex).toBe(3);
    expect(requestIdle).toHaveBeenCalledTimes(2);

    runIdle(2, false, 5);
    expect(controller.nextUnmountedIndex).toBe(5);
    runIdle(3, false, 5);
    expect(controller.allMounted).toBe(true);
    expect(requestIdle).toHaveBeenCalledTimes(3);
    stop();
  });

  it("waits without budget but advances one block after a timeout", () => {
    installIdleCallbacks();
    const controller = new ProgressiveMountController(4, 1);
    startProgressiveMounting(controller, {
      active: true,
      batchSize: 3,
      timeout: 50,
    });

    runIdle(1, false, 0);
    expect(controller.nextUnmountedIndex).toBe(1);
    runIdle(2, true, 0);
    expect(controller.nextUnmountedIndex).toBe(2);
  });

  it("cancels pending idle work", () => {
    installIdleCallbacks();
    const controller = new ProgressiveMountController(4, 1);
    const stop = startProgressiveMounting(controller, {
      active: true,
      batchSize: 2,
      timeout: 100,
    });
    const pendingCallback = idleEntries.get(1)?.callback;

    stop();
    pendingCallback?.({ didTimeout: true, timeRemaining: () => 0 });

    expect(cancelIdle).toHaveBeenCalledWith(1);
    expect(controller.nextUnmountedIndex).toBe(1);
    expect(requestIdle).toHaveBeenCalledOnce();
  });

  it("falls back to cancelable timer batches", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.stubGlobal("cancelIdleCallback", undefined);
    const controller = new ProgressiveMountController(7, 1);
    const stop = startProgressiveMounting(controller, {
      active: true,
      batchSize: 2,
      timeout: 100,
    });

    await vi.advanceTimersToNextTimerAsync();
    expect(controller.nextUnmountedIndex).toBe(3);
    await vi.advanceTimersToNextTimerAsync();
    expect(controller.nextUnmountedIndex).toBe(5);

    stop();
    await vi.runAllTimersAsync();
    expect(controller.nextUnmountedIndex).toBe(5);
  });
});

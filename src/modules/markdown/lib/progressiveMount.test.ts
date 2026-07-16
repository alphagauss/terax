import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProgressiveMountStore,
  startProgressiveMounting,
} from "./progressiveMount";

describe("ProgressiveMountStore", () => {
  it("mounts a sequential prefix and a distant target range", () => {
    const store = new ProgressiveMountStore(8, 2);

    store.mountAround(6, 1);

    expect(
      Array.from({ length: 8 }, (_, index) => store.isMounted(index)),
    ).toEqual([true, true, false, false, false, true, true, true]);
    expect(store.nextUnmountedIndex).toBe(2);
    expect(store.mountNext(3)).toBe(3);
    expect(store.allMounted).toBe(true);
  });

  it("notifies only the block that becomes mounted", () => {
    const store = new ProgressiveMountStore(3);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = store.subscribe(0, first);
    store.subscribe(1, second);

    store.mountNext(1);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();

    unsubscribe();
    store.mountNext(1);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
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

  const runIdle = (id: number, didTimeout: boolean, budget: number) => {
    const entry = idleEntries.get(id);
    if (!entry) throw new Error(`Idle callback ${id} was not scheduled`);
    idleEntries.delete(id);
    entry.callback({ didTimeout, timeRemaining: () => budget });
  };

  it("mounts idle batches and cancels pending work", () => {
    vi.stubGlobal("requestIdleCallback", requestIdle);
    vi.stubGlobal("cancelIdleCallback", cancelIdle);
    const store = new ProgressiveMountStore(7, 1);
    const stop = startProgressiveMounting(store, {
      active: true,
      batchSize: 2,
      timeout: 75,
    });

    expect(idleEntries.get(1)?.options).toEqual({ timeout: 75 });
    runIdle(1, false, 5);
    expect(store.nextUnmountedIndex).toBe(3);
    runIdle(2, true, 0);
    expect(store.nextUnmountedIndex).toBe(5);

    stop();
    expect(cancelIdle).toHaveBeenCalledWith(3);
    expect(store.nextUnmountedIndex).toBe(5);
  });

  it("uses multi-block timer batches when idle callbacks are unavailable", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.stubGlobal("cancelIdleCallback", undefined);
    const store = new ProgressiveMountStore(10, 1);
    const stop = startProgressiveMounting(store, {
      active: true,
      batchSize: 2,
      timeout: 100,
    });

    await vi.advanceTimersToNextTimerAsync();
    expect(store.nextUnmountedIndex).toBe(5);
    await vi.advanceTimersToNextTimerAsync();
    expect(store.nextUnmountedIndex).toBe(9);

    stop();
    await vi.runAllTimersAsync();
    expect(store.nextUnmountedIndex).toBe(9);
  });
});

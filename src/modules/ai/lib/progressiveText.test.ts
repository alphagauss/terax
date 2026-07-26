/**
 * 本文件验证流式可见文本的自适应推进和生命周期清理。
 * 测试锁定小积压连续显示、大积压快速追平以及清理后不再保留文本。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProgressiveTextStore,
  progressiveTextAdvanceSize,
} from "./progressiveText";

describe("progressive text", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("adapts the advance size to avoid animation debt", () => {
    expect(progressiveTextAdvanceSize(8)).toBe(12);
    expect(progressiveTextAdvanceSize(1_000)).toBe(200);
    expect(progressiveTextAdvanceSize(6_000)).toBe(2_000);
    expect(progressiveTextAdvanceSize(30_000)).toBe(30_000);
  });

  it("shows the first chunk immediately and paces later bursts", () => {
    vi.useFakeTimers();
    const store = new ProgressiveTextStore();
    const listener = vi.fn();
    store.subscribe("stream", listener);
    store.setTarget("stream", "A");
    store.setTarget("stream", `A${"b".repeat(100)}`);

    expect(store.getVisibleText("stream")).toBe("A");
    vi.advanceTimersByTime(16);
    expect(store.getVisibleText("stream").length).toBe(14);

    vi.advanceTimersByTime(1000);
    expect(store.getVisibleText("stream")).toHaveLength(101);
    store.clear("stream");
    expect(store.hasTarget("stream")).toBe(false);
  });
});

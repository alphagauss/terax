import { PerformanceObserver } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { observeReactPerformance } from "./reactPerformance";

afterEach(() => {
  vi.useRealTimers();
  performance.clearMeasures();
  vi.unstubAllGlobals();
});

it("bounds the explicit profiling retention window", async () => {
  vi.stubGlobal("PerformanceObserver", PerformanceObserver);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const dispose = observeReactPerformance(true);
  performance.measure("\u200bProfile", {
    start: 0,
    detail: {
      devtools: { track: `Components ${String.fromCodePoint(0x269b)}` },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(performance.getEntriesByName("\u200bProfile")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(performance.getEntriesByName("\u200bProfile")).toHaveLength(0);
  dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("reclaims React long-prop records without clearing application measurements", async () => {
  vi.stubGlobal("PerformanceObserver", PerformanceObserver);
  const dispose = observeReactPerformance();
  const detail = {
    devtools: {
      track: `Components ${String.fromCodePoint(0x269b)}`,
      properties: [["text", "x".repeat(100_000)]],
    },
  };
  for (let i = 0; i < 10; i++)
    performance.measure("\u200bReasoning", { start: 0, detail });
  performance.measure("application", { start: 0, detail });
  performance.measure("\u200bunrelated", { start: 0, detail: { value: 1 } });
  await vi.waitFor(() =>
    expect(performance.getEntriesByName("\u200bReasoning")).toHaveLength(0),
  );
  expect(performance.getEntriesByName("application")).toHaveLength(1);
  expect(performance.getEntriesByName("\u200bunrelated")).toHaveLength(1);
  dispose();
  performance.measure("\u200bReasoning", { start: 0, detail });
  await new Promise((resolve) => setImmediate(resolve));
  expect(performance.getEntriesByName("\u200bReasoning")).toHaveLength(1);
});

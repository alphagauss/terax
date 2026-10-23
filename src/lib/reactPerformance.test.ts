/** 验证实际 React 开发包自身回收 props 性能记录，避免依赖升级后重新引入持续增长。 */
import { createRequire } from "node:module";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { Window } from "happy-dom";
import { expect, it, vi } from "vitest";

it("React 自身回收连续更新的 props 记录，保留业务埋点和性能观察事件", async () => {
  const window = new Window();
  for (const name of ["document", "navigator", "HTMLElement", "Node"] as const)
    vi.stubGlobal(name, window[name]);
  vi.stubGlobal("window", window);
  vi.stubGlobal("performance", performance);
  // Node 测试环境提供时间戳入口，以启用与 WebView 相同的 React 性能轨道。
  vi.stubGlobal("console", { ...console, timeStamp() {} });
  const require = createRequire(import.meta.url);
  const { createElement: h } = require("react") as typeof import("react");
  const { createRoot } =
    require("react-dom/client") as typeof import("react-dom/client");
  const { flushSync } = require("react-dom") as typeof import("react-dom");
  function Snapshot({ model }: { model: { tick: number; logs: string } }) {
    return h("div", null, model.tick);
  }
  const componentEntries = () =>
    performance
      .getEntriesByType("measure")
      .filter(
        (entry) =>
          entry.name.startsWith("\u200b") &&
          (entry as import("node:perf_hooks").PerformanceMeasure).detail
            ?.devtools?.track === "Components \u269b",
      );
  let observed = 0;
  const observer = new PerformanceObserver((list) => {
    observed += list
      .getEntries()
      .filter((entry) => entry.name === "\u200bSnapshot").length;
  });
  observer.observe({ type: "measure" });
  const root = createRoot(document.createElement("div"));
  performance.measure("application", { start: 0 });
  try {
    for (let batch = 0; batch < 3; batch++) {
      for (let i = 0; i < 20; i++) {
        const tick = batch * 20 + i;
        flushSync(() =>
          root.render(
            h(Snapshot, { model: { tick, logs: "x".repeat(100_000) + tick } }),
          ),
        );
      }
      await new Promise((resolve) => setImmediate(resolve));
      expect(componentEntries()).toHaveLength(0);
    }
    // 必须确实产生事件，不能因测试环境关闭性能轨道而错误通过。
    expect(observed).toBeGreaterThan(0);
    expect(performance.getEntriesByName("application")).toHaveLength(1);
  } finally {
    flushSync(() => root.unmount());
    // 先排空 React 调度器，避免移除模拟 window 后仍有卸载收尾任务访问它。
    await new Promise((resolve) => setImmediate(resolve));
    observer.disconnect();
    vi.unstubAllGlobals();
    await window.happyDOM.close();
  }
  expect(componentEntries()).toHaveLength(0);
  performance.clearMeasures();
});

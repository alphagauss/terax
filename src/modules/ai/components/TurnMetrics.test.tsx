// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TurnMetrics } from "./TurnMetrics";
import { releaseUsage, restoreUsage } from "../lib/usageRuntime";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, args?: { value: string }) => args?.value ?? key,
  }),
}));

it("opens saved statistics on hover and excludes other turns and subagents", async () => {
  vi.useFakeTimers();
  const sessionId = "metrics-ui";
  restoreUsage(
    sessionId,
    [
      { turnId: "old", output: 100, time: 2000 },
      { turnId: "old", output: 200, time: 5000 },
      { turnId: "new", output: 9000, time: 2000 },
      { turnId: "old", output: 9000, time: 2000, taskId: "child" },
    ].map((item, index) => ({
      role: "usage",
      call_id: String(index),
      timestamp: "now",
      content: {
        turnId: item.turnId,
        taskId: item.taskId,
        model: { providerId: "test", modelId: "test" },
        contextWindow: 10000,
        values: {
          inputTokens: 100,
          cacheReadTokens: 80,
          outputTokens: item.output,
        },
        estimated: [],
        toolCalls: index === 0 ? 3 : 2,
        timing: { responseTimeMs: item.time, timeToFirstOutputMs: 1000 },
      },
    })),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<TurnMetrics sessionId={sessionId} turnId="old" />),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () =>
      container.querySelector("button")?.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerType: "mouse",
        }),
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(800));
    const panel = document.querySelector('[role="tooltip"]');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(panel?.textContent).toContain("chat.metrics.output300");
    expect(panel?.textContent).toContain(
      "chat.metrics.latestRequestCache80 / 80.0%",
    );
    expect(panel?.textContent).toContain("chat.metrics.firstToken1");
    expect(panel?.textContent).toContain("chat.metrics.speed60");
    expect(panel?.textContent).toContain("chat.metrics.toolCalls5");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    releaseUsage(sessionId);
    vi.useRealTimers();
  }
});

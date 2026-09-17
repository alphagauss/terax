// @vitest-environment happy-dom
/**
 * 本文件测试 Subagent 卡片的标题节流与详情切换。
 * 测试锁定工具标题至少显示一秒，同时 task 和最终结果保持可查阅。
 */

import i18n, { preloadEn } from "@/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentDisplayState } from "../agents/subagentDisplay";
import { releaseUsage, restoreUsage } from "../lib/usageRuntime";
import { SubagentCard } from "./SubagentCard";

const part = {
  type: "tool-run_subagent" as const,
  toolCallId: "parent-call",
  state: "output-available" as const,
  input: { task: "Inspect the persistence boundary", wait: false },
  output: { taskId: "task-1", status: "running" },
};

function display(
  patch: Partial<SubagentDisplayState> = {},
): SubagentDisplayState {
  return {
    taskId: "task-1",
    toolCallId: "parent-call",
    label: "Inspector",
    status: "running",
    phase: "thinking",
    startedAt: 0,
    steps: [],
    ...patch,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(0);
  await preloadEn();
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  document.body.replaceChildren();
  releaseUsage("subagent-usage-tab");
});

describe("SubagentCard", () => {
  it("shows only the four task statistics in a third tab", async () => {
    restoreUsage("subagent-usage-tab", [
      {
        role: "usage",
        timestamp: "now",
        content: {
          id: "child-call",
          turnId: "turn",
          taskId: "task-1",
          model: { providerId: "test", modelId: "test" },
          contextWindow: 10000,
          values: { inputTokens: 1200, cacheReadTokens: 960, outputTokens: 45 },
          estimated: [],
          toolCalls: 2,
          timing: { responseTimeMs: 1500, timeToFirstOutputMs: 500 },
        },
      },
    ]);
    await act(async () =>
      root.render(
        <SubagentCard
          sessionId="subagent-usage-tab"
          part={part as never}
          display={display({ status: "completed", result: "Final result" })}
        />,
      ),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>("button[data-state]")?.click(),
    );
    const tab = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Usage",
    );
    expect(tab).toBeDefined();
    expect(container.textContent).not.toContain("Context input");
    await act(async () => tab?.click());
    expect(container.textContent).toContain("Context input");
    expect(container.textContent).toContain("960 / 80%");
    expect(container.textContent).toContain("Turn output45 token");
    expect(container.textContent).toContain("Tool calls2");
    expect(container.textContent).not.toContain("First token latency");
    expect(container.textContent).not.toContain("Generation speed");
  });

  it("holds the visible tool action for one second without queuing stale actions", async () => {
    await act(async () => {
      root.render(<SubagentCard part={part as never} display={display()} />);
    });
    expect(container.textContent).toContain("Thinking");
    const shimmer = container.querySelector(".terax-shimmer");

    const toolDisplay = display({
      phase: "tool",
      steps: [
        {
          id: "child-call",
          toolName: "read_file",
          summary: "src/file.ts",
          status: "running",
        },
      ],
    });
    await act(async () => {
      root.render(<SubagentCard part={part as never} display={toolDisplay} />);
    });
    expect(container.textContent).toContain("Reading src/file.ts");
    expect(container.querySelector(".terax-shimmer")).toBe(shimmer);

    await act(async () => {
      root.render(
        <SubagentCard
          part={part as never}
          display={display({
            ...toolDisplay,
            status: "completed",
            durationMs: 500,
            result: "Final result",
            steps: [
              {
                ...toolDisplay.steps[0],
                status: "completed",
              },
            ],
          })}
        />,
      );
    });
    expect(container.textContent).toContain("Reading src/file.ts");

    await act(async () => vi.advanceTimersByTime(999));
    expect(container.textContent).toContain("Reading src/file.ts");
    await act(async () => vi.advanceTimersByTime(1));
    expect(container.textContent).toContain("Completed · 1 tool call · 0.5s");
  });

  it("shows the task and final result in separate compact sections", async () => {
    await act(async () => {
      root.render(
        <SubagentCard
          part={part as never}
          display={display({
            status: "completed",
            durationMs: 500,
            result: "Final result",
          })}
        />,
      );
    });

    const trigger = container.querySelector("button");
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());
    expect(container.textContent).toContain("Inspect the persistence boundary");

    const resultTab = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Result",
    );
    expect(resultTab).not.toBeUndefined();
    await act(async () => resultTab?.click());
    expect(container.textContent).toContain("Final result");
  });
});

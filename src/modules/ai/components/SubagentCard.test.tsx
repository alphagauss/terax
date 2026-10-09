// @vitest-environment happy-dom
/**
 * 本文件测试 Subagent 卡片的标题节流与详情切换。
 * 测试锁定工具标题至少显示一秒，同时 task 和最终结果保持可查阅。
 */

import i18n, { preloadEn, preloadZhCN } from "@/i18n";
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
  it("translates restored operation summaries when the interface language changes", async () => {
    await preloadZhCN();
    await act(async () => root.render(
      <SubagentCard part={part as never} display={{
        version: 2,
        taskId: "task-1",
        toolCallId: "parent-call",
        label: "Inspector",
        status: "completed",
        durationMs: 100,
        steps: [{ id: "delete", toolName: "file_operation",
          summary: [{ label: "deleteRecursive" }, "build"], status: "completed" }],
      }} />,
    ));
    await act(async () => container.querySelector<HTMLButtonElement>("button[data-state]")?.click());
    const process = [...container.querySelectorAll("button")].find((button) => button.textContent === "Process 1");
    await act(async () => process?.click());
    expect(container.textContent).toContain("Delete recursively · build");
    await act(async () => i18n.changeLanguage("zh-CN"));
    expect(container.textContent).toContain("递归删除 · build");
    expect(container.textContent).toContain("file_operation");
    expect(container.textContent).toContain("run_subagent");
  });

  it("shows only the four task statistics in a third tab", async () => {
    restoreUsage("subagent-usage-tab", [
      {
        role: "usage",
        call_id: "child-call",
        timestamp: "now",
        content: {
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
    expect(container.textContent).toContain("run_subagent");
    const shimmer = container.querySelector(".terax-shimmer");

    const toolDisplay = display({
      phase: "tool",
      steps: [
        {
          id: "child-call",
          toolName: "read_file",
          summary: ["src/file.ts"],
          status: "running",
        },
      ],
    });
    await act(async () => {
      root.render(<SubagentCard part={part as never} display={toolDisplay} />);
    });
    expect(container.textContent).toContain("read_file src/file.ts");
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
    expect(container.textContent).toContain("read_file src/file.ts");

    await act(async () => vi.advanceTimersByTime(999));
    expect(container.textContent).toContain("read_file src/file.ts");
    await act(async () => vi.advanceTimersByTime(1));
    expect(container.textContent).toContain("Completed · 1 tool call · 0.5s");
  });

  it("updates the same call immediately without restarting its hold time for equivalent summaries", async () => {
    const progress = display({ phase: "tool", steps: [{
      id: "edit", toolName: "write_file", summary: ["a.ts"], status: "running",
    }] });
    await act(async () => root.render(<SubagentCard part={part as never} display={progress} />));
    await act(async () => vi.advanceTimersByTime(500));
    const enriched = display({ ...progress, steps: [{ ...progress.steps[0], summary: [{ label: "rewrite" }, "a.ts"] }] });
    await act(async () => root.render(<SubagentCard part={part as never} display={enriched} />));
    expect(container.textContent).toContain("write_file Rewrite · a.ts");
    await act(async () => vi.advanceTimersByTime(500));
    const equivalent = JSON.parse(JSON.stringify(enriched));
    await act(async () => root.render(<SubagentCard part={part as never} display={equivalent} />));
    await act(async () => vi.advanceTimersByTime(1));
    await act(async () => root.render(<SubagentCard part={part as never} display={display({
      ...equivalent, status: "completed", durationMs: 1001,
      steps: [{ ...equivalent.steps[0], status: "completed" }],
    })} />));
    expect(container.textContent).toContain("Completed · 1 tool call · 1.0s");
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

  it("shows a distinct incomplete state at the Subagent step limit", async () => {
    await act(async () => {
      root.render(
        <SubagentCard
          part={part as never}
          display={display({
            status: "incomplete",
            durationMs: 500,
            error:
              "Subagent reached its step limit before completing the task.",
          })}
        />,
      );
    });

    expect(container.textContent).toContain("Paused at the step limit");
    await act(async () => container.querySelector("button")?.click());
    expect(container.textContent).toContain(
      "The Subagent reached its step limit before completing the task.",
    );
  });
});

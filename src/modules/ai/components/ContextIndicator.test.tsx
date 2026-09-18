// @vitest-environment happy-dom
import { act, type ReactNode, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ContextIndicator } from "./ContextIndicator";
import {
  recordUsage,
  releaseUsage,
  restoreUsage,
} from "../lib/usageRuntime";
import type { UsageRecord } from "../lib/usage";

vi.mock("@/components/ai-elements/context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/ai-elements/context")>();
  return {
    ...actual,
    Context: (props: ComponentProps<typeof actual.Context>) => (
      <actual.Context {...props} open />
    ),
  };
});

vi.mock("@/modules/ai/store/chatStore", () => ({
  sessionMetadata: new Map(),
  useChatStore: (select: (state: unknown) => unknown) =>
    select({
      selectedModel: { providerId: "test", modelId: "new" },
      draftSessionId: null,
      draftExternalAgentId: null,
    }),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (select: (state: unknown) => unknown) =>
    select({ providerModels: {}, customProviders: [] }),
}));

vi.mock("@/components/controls/tooltip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/controls/tooltip")>()),
  Hint: ({
    content,
    children,
  }: {
    content?: ReactNode;
    children: ReactNode;
  }) => (
    <>
      {children}
      <span data-hint-content>{content}</span>
    </>
  ),
}));

const id = "context-display";
const container = document.createElement("div");
let root = createRoot(container);
const record = (patch: Partial<UsageRecord> = {}): UsageRecord => ({
  id: "first",
  turnId: "turn",
  model: { providerId: "test", modelId: "old" },
  contextWindow: 128000,
  values: { inputTokens: 12000, outputTokens: 100 },
  estimated: [],
  toolCalls: 0,
  ...patch,
});
afterEach(async () => {
  await act(async () => root.unmount());
  releaseUsage(id);
  root = createRoot(container);
});

it("updates main context during a turn and preserves it across remounts without including subagents", async () => {
  restoreUsage(
    id,
    [
      record({
        id: "old-turn",
        turnId: "old-turn",
        values: { inputTokens: 1000, outputTokens: 777 },
      }),
      record({
        id: "earlier-call",
        values: { inputTokens: 10000, outputTokens: 400 },
      }),
      record({
        values: {
          inputTokens: 12000,
          cacheReadTokens: 9720,
          outputTokens: 100,
        },
      }),
      record({
        id: "child",
        taskId: "child",
        values: { inputTokens: 90000, outputTokens: 50 },
      }),
    ].map((content) => ({ role: "usage", content, timestamp: "now" })),
  );
  await act(async () =>
    root.render(
      <ContextIndicator sessionId={id} isBusy messages={[]} />,
    ),
  );
  expect(
    container.querySelector("button")?.getAttribute("aria-label"),
  ).toContain("12K / 128K");
  expect(container.querySelector("svg")).not.toBeNull();
  expect(container.querySelector("button[title]")).toBeNull();
  expect(container.querySelector('[data-slot="tooltip-trigger"]')).toBeNull();
  expect(container.textContent).toContain("9.4%");
  // 悬浮明细与圆形图表使用同一次主请求，不累加子任务或历史输入。
  expect(document.body.textContent).toContain("12,000");
  expect(document.body.textContent).not.toContain("102,000");
  expect(document.body.querySelector("button[aria-pressed]")).toBeNull();
  expect(document.body.textContent).not.toContain("500");
  expect(document.body.textContent).toContain("9.7K / 81%");
  expect(document.body.textContent).not.toContain("1,327");

  await act(async () =>
    recordUsage(
      id,
      record({
        id: "next",
        turnId: "next-turn",
        model: { providerId: "test", modelId: "new" },
        contextWindow: 64000,
        values: { inputTokens: 24000, outputTokens: 200 },
      }),
    ),
  );
  expect(
    container.querySelector("button")?.getAttribute("aria-label"),
  ).toContain("24K / 64K");
  expect(document.body.textContent).toContain("24,000");
  expect(document.body.textContent).not.toContain("9.7K / 81%");
  await act(async () =>
    recordUsage(
      id,
      record({
        id: "next-child",
        turnId: "next-turn",
        taskId: "next-child",
        values: { inputTokens: 90000, outputTokens: 50 },
      }),
    ),
  );
  expect(
    container.querySelector("button")?.getAttribute("aria-label"),
  ).toContain("24K / 64K");
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () =>
    root.render(<ContextIndicator sessionId={id} isBusy messages={[]} />),
  );
  expect(
    container.querySelector("button")?.getAttribute("aria-label"),
  ).toContain("24K / 64K");
  expect(container.textContent).toContain("37.5%");
  expect(document.body.textContent).not.toContain("200");
});

it("uses the Chinese character estimate for a session without usage records", async () => {
  await act(async () =>
    root.render(
      <ContextIndicator
        sessionId={id}
        isBusy={false}
        messages={[
          {
            id: "user",
            role: "user",
            parts: [{ type: "text", text: "中文".repeat(10) }],
          },
        ]}
      />,
    ),
  );
  expect(
    container.querySelector("button")?.getAttribute("aria-label"),
  ).toContain("≈16");
});

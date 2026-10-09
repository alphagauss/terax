// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { UsageRecord } from "../lib/usage";
import { recordUsage, releaseUsage, restoreUsage } from "../lib/usageRuntime";
import { ContextIndicator } from "./ContextIndicator";

const chatStoreState = vi.hoisted(() => ({
  selectedModel: { providerId: "test", modelId: "new" },
  draftSessionId: null as string | null,
}));

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
  useChatStore: (select: (state: unknown) => unknown) => select(chatStoreState),
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
  callId: "first",
  turnId: "turn",
  model: { providerId: "test", modelId: "old" },
  contextWindow: 128000,
  values: { inputTokens: 12000, cacheReadTokens: 9720, outputTokens: 100 },
  estimated: [],
  toolCalls: 0,
  ...patch,
});
afterEach(async () => {
  await act(async () => root.unmount());
  releaseUsage(id);
  chatStoreState.draftSessionId = null;
  root = createRoot(container);
});

it("hides context usage for a draft session", async () => {
  chatStoreState.draftSessionId = id;

  await act(async () =>
    root.render(
      <ContextIndicator sessionId={id} isBusy={false} messages={[]} />,
    ),
  );

  expect(container.childElementCount).toBe(0);
  expect(
    document.body.querySelector('[data-slot="hover-card-content"]'),
  ).toBeNull();
});

it("updates main context during a turn and preserves it across remounts without including subagents", async () => {
  restoreUsage(
    id,
    [
      record({
        callId: "old-turn",
        turnId: "old-turn",
        values: { inputTokens: 1000, cacheReadTokens: 500, outputTokens: 777 },
      }),
      record({
        callId: "earlier-call",
        values: {
          inputTokens: 10000,
          cacheReadTokens: 8000,
          outputTokens: 400,
        },
      }),
      record({
        values: {
          inputTokens: 12000,
          cacheReadTokens: 9720,
          outputTokens: 100,
        },
      }),
      record({
        callId: "child",
        taskId: "child",
        values: {
          inputTokens: 90000,
          cacheReadTokens: 80000,
          outputTokens: 50,
        },
      }),
    ].map(({ callId, ...content }) => ({
      role: "usage",
      call_id: callId,
      content,
      timestamp: "now",
    })),
  );
  await act(async () =>
    root.render(<ContextIndicator sessionId={id} isBusy messages={[]} />),
  );
  expect(
    container.querySelector("button")?.getAttribute("aria-label"),
  ).toContain("12K / 128K");
  expect(container.querySelector("svg")).not.toBeNull();
  expect(container.querySelector("button[title]")).toBeNull();
  expect(container.querySelector('[data-slot="tooltip-trigger"]')).toBeNull();
  expect(container.textContent).toContain("9.4%");
  // 圆形图表与首行使用末次主请求，其余行累计会话中的全部调用。
  expect(document.body.textContent).toContain("12,000");
  expect(document.body.textContent).toContain("98,220");
  expect(document.body.textContent).toContain("14,780");
  expect(document.body.querySelector("button[aria-pressed]")).toBeNull();
  expect(document.body.textContent).not.toContain("500");
  expect(document.body.textContent).toContain("98.2K / 86.9%");
  expect(document.body.textContent).toContain("1.3K");

  await act(async () =>
    recordUsage(
      id,
      record({
        callId: "next",
        turnId: "next-turn",
        model: { providerId: "test", modelId: "new" },
        contextWindow: 64000,
        values: {
          inputTokens: 24000,
          cacheReadTokens: 20000,
          outputTokens: 200,
        },
      }),
    ),
  );
  expect(
    container.querySelector("button")?.getAttribute("aria-label"),
  ).toContain("24K / 64K");
  expect(document.body.textContent).toContain("24,000");
  expect(document.body.textContent).toContain("118.2K / 86.3%");
  await act(async () =>
    recordUsage(
      id,
      record({
        callId: "next-child",
        turnId: "next-turn",
        taskId: "next-child",
        values: {
          inputTokens: 90000,
          cacheReadTokens: 85000,
          outputTokens: 50,
        },
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
  expect(document.body.textContent).toContain("203.2K / 89.5%");
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

it("shows a cache regression beside the context indicator and keeps its history after recovery", async () => {
  restoreUsage(
    id,
    [
      record({
        callId: "baseline-start",
        values: {
          inputTokens: 10000,
          cacheReadTokens: 9000,
          outputTokens: 100,
        },
      }),
      record({
        callId: "baseline",
        values: {
          inputTokens: 12000,
          cacheReadTokens: 9000,
          outputTokens: 100,
        },
      }),
      record({
        callId: "regressed",
        values: {
          inputTokens: 13000,
          cacheReadTokens: 4000,
          outputTokens: 100,
        },
      }),
    ].map(({ callId, ...content }) => ({
      role: "usage",
      call_id: callId,
      content,
      timestamp: "now",
    })),
  );

  await act(async () =>
    root.render(
      <ContextIndicator sessionId={id} isBusy={false} messages={[]} />,
    ),
  );

  expect(
    container.querySelector("button")?.getAttribute("aria-label"),
  ).toContain("miniWindow.context.cacheAnomaly");
  expect(document.body.textContent).toContain(
    "miniWindow.context.cacheAnomaly",
  );
  expect(document.body.textContent).toContain(
    "miniWindow.context.cacheAnomalyDetails",
  );

  await act(async () =>
    recordUsage(
      id,
      record({
        callId: "recovered",
        values: {
          inputTokens: 14000,
          cacheReadTokens: 12500,
          outputTokens: 100,
        },
      }),
    ),
  );

  expect(document.body.textContent).toContain(
    "miniWindow.context.cacheRecovered",
  );
  expect(document.body.textContent).toContain(
    "miniWindow.context.cacheAnomalyCount",
  );
});

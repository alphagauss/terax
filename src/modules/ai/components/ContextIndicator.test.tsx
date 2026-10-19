// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { UsageRecord } from "../lib/usage";
import {
  recordUsage,
  releaseUsage,
  restoreUsage,
  pendingUsage,
} from "../lib/usageRuntime";
import { estimateMessageTokens } from "../lib/usage";
import { formatTokens } from "./UsageDetails";
import {
  conversationEventPart,
  convertToAgentModelMessages,
  projectSessionMessages,
  type SessionMessage,
} from "../lib/conversation";
import type { UIMessage } from "ai";
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

it("shows child cache incidents with diagnostic IDs without replacing the main context", async () => {
  restoreUsage(
    id,
    [
      record({
        callId: "main",
        values: {
          inputTokens: 12000,
          cacheReadTokens: 9000,
          outputTokens: 100,
        },
      }),
      record({
        callId: "child-before",
        taskId: "task-identity",
        runId: "run-before",
        values: {
          inputTokens: 50000,
          cacheReadTokens: 40000,
          outputTokens: 100,
        },
      }),
      record({
        callId: "child-after",
        taskId: "task-identity",
        runId: "run-after",
        turnId: "parent-after",
        values: {
          inputTokens: 51000,
          cacheReadTokens: 1000,
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
  ).toContain("12K / 128K");
  expect(
    container.querySelector("button")?.getAttribute("aria-label"),
  ).toContain("miniWindow.context.cacheAnomaly");
  for (const value of [
    id,
    "task-identity",
    "run-after",
    "parent-after",
    "child-before",
    "child-after",
  ])
    expect(document.body.textContent).toContain(value);
  await act(async () =>
    recordUsage(
      id,
      record({
        callId: "main-healthy",
        values: {
          inputTokens: 14000,
          cacheReadTokens: 12000,
          outputTokens: 100,
        },
      }),
    ),
  );
  expect(
    container.querySelector("button")?.getAttribute("aria-label"),
  ).toContain("miniWindow.context.cacheAnomaly");
});

it.each([false, true])(
  "压缩预估包含最新工具开销并可恢复，旧调用缺少开销=%s",
  async (missingOverhead) => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const old = record({
      context: {
        overheadHash: "system",
        prefixHash: "old",
        messageCount: 2,
        overheadTokens: missingOverhead ? undefined : 100,
      },
    });
    recordUsage(id, old);
    recordUsage(
      id,
      record({
        callId: "summary",
        purpose: "compaction",
        context: {
          overheadHash: "summary",
          prefixHash: "summary",
          messageCount: 3,
          overheadTokens: 8000,
        },
      }),
    );
    const messages: UIMessage[] = [
      { id: "u", role: "user", parts: [{ type: "text", text: "request" }] },
      {
        id: "a",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "x".repeat(20000) },
          { type: "text", text: "answer" },
        ],
      },
      {
        id: "c",
        role: "assistant",
        parts: [
          conversationEventPart({
            event: "compaction",
            id: "checkpoint",
            throughUserMessageId: "u",
            summary: "handoff",
          }),
        ],
      },
    ];
    const render = () =>
      act(() =>
        root.render(
          <ContextIndicator
            sessionId={id}
            isBusy={false}
            messages={messages}
          />,
        ),
      );
    render();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "miniWindow.context.estimating",
    );
    const label = () =>
      container.querySelector("button[aria-label]")?.getAttribute("aria-label");
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(label()).toContain("≈");
    });
    const estimate = label();
    expect(estimate).toContain(
      formatTokens(
        8000 +
          estimateMessageTokens(await convertToAgentModelMessages(messages)),
      ),
    );
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(label()).toBe(estimate);
    });
    await act(async () =>
      recordUsage(
        id,
        record({
          callId: "after",
          context: {
            overheadHash: "system",
            prefixHash: "after",
            messageCount: 3,
            compactionId: "checkpoint",
          },
          values: { inputTokens: 800, outputTokens: 20 },
        }),
      ),
    );
    expect(label()).not.toContain("≈");
    expect(label()).toContain("800");
  },
);

it.each([false, true])(
  "按落盘顺序恢复压缩后的实际用量，是否已有后续主调用=%s",
  async (hasMainCall) => {
    const timestamp = "2026-10-19T04:56:25.357Z";
    const usage = (callId: string, purpose?: "compaction"): SessionMessage => {
      const { callId: call_id, ...content } = record({
        callId,
        purpose,
        values: { inputTokens: 14477, outputTokens: 65 },
        context: {
          overheadHash: "system",
          prefixHash: "prefix",
          messageCount: 18,
          overheadTokens: 100,
        },
      });
      return { role: "usage", call_id, timestamp, content };
    };
    const checkpoint: SessionMessage = {
      role: "event",
      timestamp,
      content: {
        event: "compaction",
        id: "checkpoint",
        throughUserMessageId: "user",
        summary: "handoff",
      },
    };
    const saved: SessionMessage[] = [
      { role: "user", message_id: "user", content: "request", timestamp },
      usage("before"),
      usage("summary", "compaction"),
      checkpoint,
      checkpoint,
      ...(hasMainCall ? [usage("after")] : []),
      usage("failed-summary", "compaction"),
    ];
    const original = JSON.stringify(saved);
    restoreUsage(id, saved);
    await act(async () =>
      root.render(
        <ContextIndicator
          sessionId={id}
          isBusy={false}
          messages={projectSessionMessages(id, saved)}
        />,
      ),
    );
    await vi.waitFor(async () => {
      await act(async () => {});
      const label = container
        .querySelector("button")
        ?.getAttribute("aria-label");
      if (hasMainCall) {
        expect(label).toContain("14.5K");
        expect(label).not.toContain("≈");
      } else {
        expect(label).toContain("≈");
        expect(label).not.toContain("14.5K");
      }
    });
    expect(JSON.stringify(saved)).toBe(original);
    expect(pendingUsage(id, timestamp)).toEqual([]);
  },
);

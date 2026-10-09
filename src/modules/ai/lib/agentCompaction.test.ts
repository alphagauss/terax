/** 验证压缩请求、检查点提交与会话循环的真实 SDK 边界。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { readUIMessageStream, type UIMessage } from "ai";
import { Chat } from "@ai-sdk/react";
import { AgentTurnCoordinator } from "@/modules/ai/agents/subagentRuntime";
import { runAgentStream, type RunAgentOptions } from "@/modules/ai/lib/agent";
import { modelRefForProvider } from "@/modules/ai/config";
import { EMPTY_PROVIDER_KEYS } from "@/modules/ai/lib/keyring";
import {
  convertToAgentModelMessages,
  projectSessionMessages,
  serializeSessionMessages,
  type SessionMessage,
} from "@/modules/ai/lib/conversation";
import {
  recordUsage,
  releaseUsage,
  usageRecords,
} from "@/modules/ai/lib/usageRuntime";

let activeModel: MockLanguageModelV4;
vi.mock("@/modules/ai/lib/providerRuntime", () => ({
  buildConfiguredLanguageModel: async () => activeModel,
  createProviderDownload: () => undefined,
}));
const sessionId = "compaction-test";
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const user = (id: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: id }],
});
const attachment = {
  kind: "file" as const,
  name: "old.txt",
  size: 8,
  path: "/workspace/old.txt",
  environmentKey: "local",
};
const selection = {
  kind: "selection" as const,
  id: "editor-selection",
  source: "editor" as const,
  path: "/workspace/source.ts",
  text: "selected source",
};
const snippet = {
  kind: "snippet" as const,
  id: "review",
  handle: "review",
  content: "review instructions",
};
function history(): UIMessage[] {
  const oldUser = user("old-user");
  oldUser.metadata = { attachments: [attachment, selection, snippet] };
  return [
    oldUser,
    {
      id: "old-answer",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "old private process" },
        {
          type: "tool-get_terminal_output",
          toolCallId: "old-call",
          state: "output-available",
          input: {},
          output: "old terminal output",
        },
        { type: "step-start" },
        { type: "text", text: "old final answer" },
      ],
    },
  ];
}
function generated(text = "handoff") {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage,
    warnings: [],
  };
}
function stream(tool = false, highUsage = false) {
  const chunks = tool
    ? [
        {
          type: "tool-call",
          toolCallId: "new-call",
          toolName: "get_terminal_output",
          input: "{}",
        },
      ]
    : [
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: "new final answer" },
        { type: "text-end", id: "text" },
      ];
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.enqueue({
          type: "finish",
          usage: highUsage
            ? {
                ...usage,
                inputTokens: {
                  total: 190000,
                  noCache: 190000,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
              }
            : usage,
          finishReason: {
            unified: tool ? "tool-calls" : "stop",
            raw: tool ? "tool_calls" : "stop",
          },
        });
        controller.close();
      },
    }),
  } as never;
}
function options(): RunAgentOptions {
  return {
    turnId: "turn",
    keys: EMPTY_PROVIDER_KEYS,
    model: modelRefForProvider("lmstudio", "model"),
    systemPrompt: "stable system",
    allowedTools: ["get_terminal_output"],
    maxConcurrentSubagents: 1,
    turnCoordinator: new AgentTurnCoordinator(),
    toolContext: {
      getSessionId: () => sessionId,
      getCwd: () => "/workspace",
      getTerminalContext: () => "new terminal output",
      isActiveTerminalPrivate: () => false,
      getPermissionMode: () => "full-access",
      supportsApprovals: true,
    },
    uiMessages: [...history(), user("new-user")],
    onCheckpoint: vi.fn(),
  };
}
function highUsage(opts: RunAgentOptions) {
  recordUsage(sessionId, {
    callId: "last",
    turnId: "previous",
    model: opts.model,
    contextWindow: 200000,
    values: { inputTokens: 190000, outputTokens: 10 },
    estimated: [],
    toolCalls: 0,
  });
}
async function consume(opts: RunAgentOptions) {
  const result = await runAgentStream(opts);
  const errors: unknown[] = [];
  let message: UIMessage | undefined;
  for await (const update of readUIMessageStream({
    stream: result.toUIMessageStream(),
    onError: (error) => errors.push(error),
  }))
    message = update;
  return { message, errors };
}
afterEach(() => releaseUsage(sessionId));

describe("Agent compaction", () => {
  it("accepts an attachment-only message through the SDK Chat boundary", async () => {
    activeModel = new MockLanguageModelV4({
      doStream: async () => stream(),
    });
    const opts = options();
    opts.uiMessages = [];
    let submitted: UIMessage[] = [];
    const chat = new Chat<UIMessage>({
      id: sessionId,
      transport: {
        sendMessages: async ({ messages }) => {
          submitted = messages;
          opts.uiMessages = messages;
          return (await runAgentStream(opts)).toUIMessageStream({
            originalMessages: messages,
          });
        },
        reconnectToStream: async () => null,
      },
    });
    await chat.sendMessage({
      role: "user",
      parts: [],
      metadata: { attachments: [attachment, selection, snippet] },
    });
    expect(chat.error).toBeUndefined();
    expect(submitted[submitted.length - 1]?.parts).toEqual([]);
    expect(JSON.stringify(activeModel.doStreamCalls[0].prompt)).toContain(
      attachment.path,
    );
    expect(JSON.stringify(activeModel.doStreamCalls[0].prompt)).toContain(
      selection.path,
    );
    expect(JSON.stringify(activeModel.doStreamCalls[0].prompt)).toContain(
      snippet.content,
    );
  });

  it("keeps an attachment-only user prefix stable across persistence and tool continuation", async () => {
    activeModel = new MockLanguageModelV4({
      doStream: async () =>
        stream(activeModel.doStreamCalls.length === 1, false),
    });
    const opts = options();
    opts.uiMessages = [
      {
        id: "attachment-only",
        role: "user",
        parts: [],
        metadata: { attachments: [attachment, selection, snippet] },
      },
    ];
    const { errors } = await consume(opts);
    expect(errors).toEqual([]);
    expect(activeModel.doStreamCalls).toHaveLength(2);
    const first = activeModel.doStreamCalls[0].prompt;
    const second = activeModel.doStreamCalls[1].prompt;
    expect(JSON.stringify(first)).toContain(attachment.path);
    expect(JSON.stringify(first)).toContain(selection.text);
    expect(JSON.stringify(first)).toContain(snippet.content);
    expect(second.slice(0, first.length)).toEqual(first);

    const records = serializeSessionMessages(opts.uiMessages, {
      turnId: "turn",
      timestamp: "now",
    });
    expect(
      await convertToAgentModelMessages(
        projectSessionMessages(sessionId, records),
      ),
    ).toEqual(first.slice(1));
  });

  it("preserves the request prefix and tool definitions, waits for persistence, then consumes queued guidance", async () => {
    let finishSummary!: () => void;
    activeModel = new MockLanguageModelV4({
      doGenerate: () =>
        new Promise((resolve) => {
          finishSummary = () => resolve(generated());
        }),
      doStream: async () => stream(),
    });
    const opts = options();
    highUsage(opts);
    let save!: () => void;
    opts.onCheckpoint = vi.fn(async (_messages, event) => {
      if (event.event === "compaction")
        await new Promise<void>((resolve) => {
          save = resolve;
        });
    });
    const states: boolean[] = [];
    opts.onCompacting = (state) => states.push(state);
    const running = consume(opts);
    await vi.waitFor(() => expect(finishSummary).toBeTypeOf("function"));
    const receipt = opts.turnCoordinator.inbox.steer(user("correction"));
    expect(receipt).not.toBeNull();
    expect(activeModel.doStreamCalls).toHaveLength(0);
    const prefix = await convertToAgentModelMessages(opts.uiMessages);
    const request = activeModel.doGenerateCalls[0];
    expect(request.prompt.slice(1, -1)).toEqual(prefix);
    expect(JSON.stringify(request.prompt)).toContain("old terminal output");
    expect(JSON.stringify(request.prompt)).toContain("/workspace/old.txt");
    expect(JSON.stringify(request.prompt)).toContain(selection.text);
    expect(JSON.stringify(request.prompt)).toContain(snippet.content);
    expect(request.tools?.map((tool) => tool.name)).toContain(
      "get_terminal_output",
    );
    finishSummary();
    await vi.waitFor(() => expect(save).toBeTypeOf("function"));
    expect(activeModel.doStreamCalls).toHaveLength(0);
    save();
    const { message, errors } = await running;
    expect(errors).toEqual([]);
    expect(await receipt).toBe("consumed");
    expect(states).toEqual([true, false]);
    expect(
      vi.mocked(opts.onCheckpoint).mock.calls.map((call) => call[1].event),
    ).toEqual(["compaction", "user_steering"]);
    const next = JSON.stringify(activeModel.doStreamCalls[0].prompt);
    expect(next).toContain("handoff");
    expect(next).toContain("old final answer");
    expect(next).not.toContain("old terminal output");
    expect(next).not.toContain("/workspace/old.txt");
    expect(next).not.toContain(selection.text);
    expect(next).not.toContain(snippet.content);
    expect(next).toContain("correction");
    expect(message?.parts.some((part) => part.type === "data-compaction")).toBe(
      true,
    );
    expect(
      usageRecords(sessionId).filter(
        (record) => record.purpose === "compaction",
      ),
    ).toHaveLength(1);
  });

  it("compacts between tool steps, closes activity and protects the entire current turn", async () => {
    activeModel = new MockLanguageModelV4({
      doGenerate: async () => generated(),
      doStream: async () =>
        stream(
          activeModel.doStreamCalls.length === 1,
          activeModel.doStreamCalls.length === 1,
        ),
    });
    const opts = options();
    opts.model = modelRefForProvider("anthropic", "model");
    const { message, errors } = await consume(opts);
    expect(errors).toEqual([]);
    expect(activeModel.doGenerateCalls).toHaveLength(1);
    const previous = activeModel.doStreamCalls[0];
    const summary = activeModel.doGenerateCalls[0];
    expect(summary.prompt.slice(0, previous.prompt.length)).toEqual(
      previous.prompt,
    );
    expect(JSON.stringify(previous.prompt)).toContain("/workspace/old.txt");
    expect(JSON.stringify(previous.prompt)).toContain(selection.text);
    expect(JSON.stringify(previous.prompt)).toContain(snippet.content);
    expect(summary.tools).toEqual(previous.tools);
    const finalPrompt = JSON.stringify(activeModel.doStreamCalls[1].prompt);
    expect(finalPrompt).not.toContain("old terminal output");
    expect(finalPrompt).not.toContain("/workspace/old.txt");
    expect(finalPrompt).not.toContain(selection.text);
    expect(finalPrompt).not.toContain(snippet.content);
    expect(finalPrompt).toContain("new terminal output");
    const parts = message?.parts ?? [];
    expect(
      parts.findIndex((part) => part.type === "data-activity-duration"),
    ).toBeLessThan(parts.findIndex((part) => part.type === "data-compaction"));
    const records: SessionMessage[] = [
      ...serializeSessionMessages(opts.uiMessages, {
        turnId: "history",
        timestamp: "now",
      }),
      ...serializeSessionMessages(message ? [message] : [], {
        turnId: "turn",
        timestamp: "now",
      }),
    ];
    expect(
      await convertToAgentModelMessages(
        projectSessionMessages(sessionId, records),
      ),
    ).toEqual(
      await convertToAgentModelMessages([
        ...opts.uiMessages,
        ...(message ? [message] : []),
      ]),
    );
  });

  it("aborts without committing a checkpoint or consuming guidance", async () => {
    const abort = new AbortController();
    activeModel = new MockLanguageModelV4({
      doGenerate: async ({ abortSignal }) =>
        new Promise((_resolve, reject) =>
          abortSignal?.addEventListener(
            "abort",
            () => reject(abortSignal.reason),
            { once: true },
          ),
        ),
    });
    const opts = options();
    opts.abortSignal = abort.signal;
    highUsage(opts);
    const running = consume(opts);
    await vi.waitFor(() => expect(activeModel.doGenerateCalls).toHaveLength(1));
    const receipt = opts.turnCoordinator.inbox.steer(user("queued"));
    abort.abort();
    await running;
    expect(await receipt).toBe("cancelled");
    expect(opts.onCheckpoint).not.toHaveBeenCalled();
    expect(activeModel.doStreamCalls).toHaveLength(0);
  });

  it("never executes a tool proposed by the summarizer", async () => {
    activeModel = new MockLanguageModelV4({
      doGenerate: async () => ({
        ...generated(),
        content: [
          {
            type: "tool-call",
            toolCallId: "forbidden",
            toolName: "get_terminal_output",
            input: "{}",
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
      }),
    });
    const opts = options();
    const execute = vi.fn(() => "must not execute");
    opts.toolContext.getTerminalContext = execute;
    opts.compactOnly = "";
    const { errors } = await consume(opts);
    expect(errors).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    expect(opts.onCheckpoint).not.toHaveBeenCalled();
    expect(activeModel.doGenerateCalls).toHaveLength(1);
  });

  it.each(["empty", "length"])(
    "rejects a %s summary without retrying or replacing history",
    async (kind) => {
      activeModel = new MockLanguageModelV4({
        doGenerate: async () => ({
          ...generated(kind === "empty" ? "" : "partial"),
          finishReason: {
            unified: kind === "length" ? "length" : "stop",
            raw: kind,
          },
        }),
      });
      const opts = options();
      opts.compactOnly = "";
      expect((await consume(opts)).errors).toHaveLength(1);
      expect(opts.onCheckpoint).not.toHaveBeenCalled();
      expect(activeModel.doGenerateCalls).toHaveLength(1);
      expect(activeModel.doStreamCalls).toHaveLength(0);
    },
  );

  it("does not call a provider or create a checkpoint when there is nothing to remove", async () => {
    activeModel = new MockLanguageModelV4({});
    const opts = options();
    opts.compactOnly = "";
    opts.uiMessages = [
      user("plain"),
      {
        id: "a",
        role: "assistant",
        parts: [{ type: "step-start" }, { type: "text", text: "answer" }],
      },
    ];
    const chat = new Chat<UIMessage>({
      id: sessionId,
      messages: opts.uiMessages,
      transport: {
        sendMessages: async () =>
          (await runAgentStream(opts)).toUIMessageStream(),
        reconnectToStream: async () => null,
      },
    });
    await chat.sendMessage();
    expect(chat.messages).toEqual(opts.uiMessages);
    expect(opts.onCheckpoint).not.toHaveBeenCalled();
    expect(activeModel.doGenerateCalls).toHaveLength(0);
    expect(activeModel.doStreamCalls).toHaveLength(0);
  });

  it("manual compaction creates a new SDK message, keeps the previous answer and makes no continuation request", async () => {
    activeModel = new MockLanguageModelV4({
      doGenerate: async () => generated(),
    });
    const opts = options();
    opts.compactOnly = "preserve tests";
    opts.uiMessages = history();
    const chat = new Chat<UIMessage>({
      id: sessionId,
      messages: opts.uiMessages,
      transport: {
        sendMessages: async () =>
          (await runAgentStream(opts)).toUIMessageStream(),
        reconnectToStream: async () => null,
      },
    });
    await chat.sendMessage();
    expect(chat.error).toBeUndefined();
    expect(chat.messages).toHaveLength(3);
    expect(chat.messages[1]).toEqual(opts.uiMessages[1]);
    expect(chat.messages[2].id).not.toBe(chat.messages[1].id);
    expect(
      chat.messages[2].parts.some((part) => part.type === "data-compaction"),
    ).toBe(true);
    expect(activeModel.doStreamCalls).toHaveLength(0);
    expect(vi.mocked(opts.onCheckpoint).mock.calls[0][0]).toEqual([]);
    expect(JSON.stringify(activeModel.doGenerateCalls[0].prompt)).toContain(
      "preserve tests",
    );
  });
});

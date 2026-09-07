/**
 * 本文件验证不挂载 UI 的 Agent 生命周期。
 * 锁定终态保存、审批阻塞与拒绝续传，以及保存失败不能触发重复提交。
 */

import { Chat } from "@ai-sdk/react";
import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelAgentRun, observeAgentRun } from "@/modules/ai/lib/runLifecycle";

const cleanup = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/modules/ai/lib/sessions", () => ({
  clearSessionProcesses: cleanup,
}));

afterEach(() => vi.useRealTimers());

function setup(chunks: UIMessageChunk[], failCommit = false) {
  let owned = true;
  const transport = {
    sendMessages: vi.fn(
      async () =>
        new ReadableStream<UIMessageChunk>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
    ),
    reconnectToStream: async () => null,
  };
  const chat = new Chat<UIMessage>({
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });
  const commit = vi.fn(async () => {
    if (failCommit) throw new Error("disk full");
    owned = false;
  });
  const onError = vi.fn();
  const onApprovals = vi.fn();
  const lifecycle = observeAgentRun(chat, {
    sessionId: "session",
    isOwned: () => owned,
    commit,
    onError,
    onApprovals,
    onMessages: vi.fn(),
    onStatus: vi.fn(),
  });
  return { chat, lifecycle, commit, onError, onApprovals, transport };
}

describe("Agent run lifecycle without UI", () => {
  it("cancels a pending approval without resuming the model or unlocking before cleanup", async () => {
    vi.useFakeTimers();
    const run = setup([
      { type: "start", messageId: "answer" },
      {
        type: "tool-input-available",
        toolCallId: "tool",
        toolName: "shell_exec",
        input: { command: "test" },
      },
      {
        type: "tool-approval-request",
        approvalId: "approval",
        toolCallId: "tool",
      },
      { type: "finish", finishReason: "tool-calls" },
    ]);
    await run.chat.sendMessage({ text: "hello" });
    await vi.runAllTimersAsync();
    let releaseCleanup = () => {};
    cleanup.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    );
    const stopping = cancelAgentRun(run.chat, "session");
    await vi.runAllTimersAsync();
    expect(run.commit).not.toHaveBeenCalled();
    releaseCleanup();
    await stopping;
    await vi.runAllTimersAsync();
    expect(run.transport.sendMessages).toHaveBeenCalledOnce();
    expect(run.commit).toHaveBeenCalledOnce();
    expect(run.chat.messages[1].parts).toContainEqual(
      expect.objectContaining({ state: "output-denied" }),
    );
    run.lifecycle.dispose();
  });
  it("commits a complete streamed turn without mounting React", async () => {
    vi.useFakeTimers();
    const run = setup([
      { type: "start", messageId: "answer" },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "done" },
      { type: "text-end", id: "text" },
      { type: "finish", finishReason: "stop" },
    ]);
    await run.chat.sendMessage({ text: "hello" });
    await vi.runAllTimersAsync();
    expect(run.commit).toHaveBeenCalledExactlyOnceWith(run.chat.messages);
    expect(
      run.chat.messages[run.chat.messages.length - 1]?.parts,
    ).toContainEqual({ type: "text", text: "done", state: "done" });
    run.lifecycle.dispose();
  });

  it("waits for approval and preserves a denied result before completing", async () => {
    vi.useFakeTimers();
    const run = setup([
      { type: "start", messageId: "answer" },
      {
        type: "tool-input-available",
        toolCallId: "tool",
        toolName: "shell_exec",
        input: { command: "test" },
      },
      {
        type: "tool-approval-request",
        approvalId: "approval",
        toolCallId: "tool",
      },
      { type: "finish", finishReason: "tool-calls" },
    ]);
    await run.chat.sendMessage({ text: "hello" });
    await vi.runAllTimersAsync();
    expect(run.commit).not.toHaveBeenCalled();
    expect(run.onApprovals).toHaveBeenLastCalledWith([
      expect.objectContaining({ approvalId: "approval" }),
    ]);
    run.transport.sendMessages.mockImplementationOnce(
      async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: "tool-output-denied",
              toolCallId: "tool",
            });
            controller.enqueue({ type: "finish", finishReason: "stop" });
            controller.close();
          },
        }),
    );
    await run.lifecycle.respond("approval", false);
    await vi.runAllTimersAsync();
    expect(run.commit).toHaveBeenCalledOnce();
    expect(
      run.chat.messages[run.chat.messages.length - 1]?.parts,
    ).toContainEqual(
      expect.objectContaining({
        state: "output-denied",
        approval: expect.objectContaining({ approved: false }),
      }),
    );
    run.lifecycle.dispose();
  });

  it("reports persistence failure without retrying on unrelated notifications", async () => {
    vi.useFakeTimers();
    const run = setup([], true);
    await run.chat.sendMessage({ text: "hello" });
    await vi.runAllTimersAsync();
    run.chat.messages = [...run.chat.messages];
    await vi.runAllTimersAsync();
    expect(run.commit).toHaveBeenCalledOnce();
    expect(run.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "disk full" }),
    );
    run.lifecycle.dispose();
  });
});

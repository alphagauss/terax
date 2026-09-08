import type { UIMessageChunk } from "ai";
import { afterEach, expect, it, vi } from "vitest";
import { coalesceStream } from "./coalesceStream";

afterEach(() => vi.useRealTimers());

const delta = (text: string): UIMessageChunk => ({
  type: "reasoning-delta",
  id: "r",
  delta: text,
});

it("releases the reader when cancelled before the first pull", async () => {
  const cancel = vi.fn();
  const source = new ReadableStream<UIMessageChunk>({ cancel });
  await coalesceStream(source).cancel("before start");
  expect(cancel).toHaveBeenCalledWith("before start");
  expect(source.locked).toBe(false);
});

it("coalesces text before message snapshots without crossing protocol or metadata boundaries", async () => {
  vi.useFakeTimers();
  const input: UIMessageChunk[] = [
    { type: "reasoning-start", id: "r" },
    delta("a"),
    delta("b"),
    delta("c"),
    {
      ...delta("d"),
      providerMetadata: { test: { signature: "signed" } },
    } as UIMessageChunk,
    { type: "reasoning-end", id: "r" },
    {
      type: "tool-approval-request",
      approvalId: "approval",
      toolCallId: "tool",
    },
    { type: "finish" },
  ];
  const output = [];
  for await (const chunk of coalesceStream(
    new ReadableStream({
      start(controller) {
        for (const chunk of input) controller.enqueue(chunk);
        controller.close();
      },
    }),
  ))
    output.push(chunk);
  expect(output).toEqual([
    input[0],
    delta("a"),
    delta("bc"),
    input[4],
    ...input.slice(5),
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it("flushes a quiet partial response on time and releases a blocked source on cancellation", async () => {
  vi.useFakeTimers();
  let controller!: ReadableStreamDefaultController<UIMessageChunk>;
  const cancel = vi.fn();
  const source = new ReadableStream<UIMessageChunk>({
    start(value) {
      controller = value;
    },
    cancel,
  });
  const reader = coalesceStream(source).getReader();
  controller.enqueue(delta("first"));
  expect((await reader.read()).value).toEqual(delta("first"));
  controller.enqueue(delta("last"));
  const next = reader.read();
  await vi.advanceTimersByTimeAsync(32);
  expect((await next).value).toEqual(delta("last"));
  await reader.cancel("stop");
  expect(cancel).toHaveBeenCalledWith("stop");
  expect(source.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("delivers buffered text before an upstream failure", async () => {
  let controller!: ReadableStreamDefaultController<UIMessageChunk>;
  const reader = coalesceStream(
    new ReadableStream<UIMessageChunk>({
      start(value) {
        controller = value;
      },
    }),
  ).getReader();
  controller.enqueue(delta("a"));
  await reader.read();
  controller.enqueue(delta("b"));
  const next = reader.read();
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.error(new Error("disconnected"));
  expect((await next).value).toEqual(delta("b"));
  await expect(reader.read()).rejects.toThrow("disconnected");
});

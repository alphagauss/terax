/**
 * 本文件验证通用 HTTP 的取消和事件交接边界。
 * 提前取消必须等原生登记后回收请求，命令完成不能截断尚在投递的正文事件。
 */

import { createHttpFetch } from "@/lib/http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  invoke: vi.fn(),
  resolve: () => {},
  request: null as null | {
    requestId: string;
    onEvent: { onmessage: (event: unknown) => void };
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
  invoke: io.invoke,
}));

beforeEach(() => {
  io.invoke.mockReset();
  io.request = null;
  io.invoke.mockImplementation((command, args) => {
    if (command === "http_cancel") return Promise.resolve();
    io.request = args;
    return new Promise<void>((resolve) => {
      io.resolve = resolve;
    });
  });
});

describe("native HTTP lifecycle", () => {
  it("forwards an early abort after native registration", async () => {
    const abort = new AbortController();
    const result = createHttpFetch()("https://example.com", {
      signal: abort.signal,
    });
    const rejected = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(io.request).not.toBeNull());
    abort.abort();
    await rejected;
    expect(io.invoke).toHaveBeenCalledTimes(1);
    io.request?.onEvent.onmessage({ kind: "started" });
    expect(io.invoke).toHaveBeenLastCalledWith("http_cancel", {
      requestId: io.request?.requestId,
    });
    io.resolve();
  });

  it("consumes terminal events even if command completion arrives first", async () => {
    const result = createHttpFetch()("https://example.com");
    await vi.waitFor(() => expect(io.request).not.toBeNull());
    io.resolve();
    await Promise.resolve();
    await Promise.resolve();
    io.request?.onEvent.onmessage({
      kind: "headers",
      status: 200,
      headers: {},
    });
    io.request?.onEvent.onmessage({ kind: "chunk", bytes: [79, 75] });
    io.request?.onEvent.onmessage({ kind: "end" });
    expect(await (await result).text()).toBe("OK");
  });
});

import { beforeEach, expect, it, vi } from "vitest";
import { httpFileRequest, withPreparedHttpFile } from "@/lib/httpFiles";

const io = vi.hoisted(() => ({
  invoke: vi.fn(),
  channel: { onmessage: (_event: { kind: string }) => {} },
}));
vi.mock("@/lib/nativeHost", () => ({
  getNativeHost: async () => ({ invoke: io.invoke, channel: () => io.channel }),
}));
beforeEach(() => {
  io.invoke.mockReset();
});

it("cancels a file request when abort precedes native start acknowledgement", async () => {
  let complete!: () => void;
  const native = new Promise<void>((resolve) => {
    complete = resolve;
  });
  io.invoke.mockImplementation((command: string) =>
    command === "http_file_request" ? native : Promise.resolve(),
  );
  const abort = new AbortController();
  const download = httpFileRequest(
    {
      url: "https://files.example/a",
      method: "GET",
      networkTarget: { kind: "direct" },
    },
    abort.signal,
  );
  const rejected = expect(download).rejects.toThrow();
  await vi.waitFor(() => expect(io.invoke).toHaveBeenCalledTimes(1));
  abort.abort();
  expect(io.invoke).toHaveBeenCalledTimes(1);
  io.channel.onmessage({ kind: "started" });
  expect(io.invoke).toHaveBeenCalledWith("http_cancel", {
    requestId: io.invoke.mock.calls[0][1].requestId,
  });
  complete();
  await rejected;
});

it("releases the exact prepared file when platform negotiation fails", async () => {
  io.invoke.mockResolvedValue({
    name: "a",
    size: 1,
    bodySize: 16,
    md5: "digest",
  });
  const use = vi.fn(async () => {
    throw new Error("negotiation failed");
  });
  await expect(
    withPreparedHttpFile(
      {
        root: "/root",
        ownerSessionId: "session",
        permissionMode: "full-access",
        path: "a",
        maxBytes: 100,
      },
      new AbortController().signal,
      use,
    ),
  ).rejects.toThrow("negotiation failed");
  const requestId = io.invoke.mock.calls[0][1].requestId;
  expect(use).toHaveBeenCalledWith(
    expect.objectContaining({ id: requestId, size: 1, bodySize: 16 }),
  );
  expect(io.invoke).toHaveBeenLastCalledWith("http_release_file", {
    fileId: requestId,
  });
});

it("releases a prepared file even if cancellation hides its completed response", async () => {
  const abort = new AbortController();
  io.invoke.mockImplementation(async (command: string) => {
    if (command === "http_prepare_file") {
      abort.abort();
      return { name: "a", size: 1, bodySize: 1, md5: "digest" };
    }
  });
  const use = vi.fn();
  await expect(
    withPreparedHttpFile(
      {
        root: "/root",
        ownerSessionId: "session",
        permissionMode: "full-access",
        path: "a",
        maxBytes: 100,
      },
      abort.signal,
      use,
    ),
  ).rejects.toThrow();
  expect(use).not.toHaveBeenCalled();
  expect(io.invoke).toHaveBeenLastCalledWith("http_release_file", {
    fileId: io.invoke.mock.calls[0][1].requestId,
  });
});

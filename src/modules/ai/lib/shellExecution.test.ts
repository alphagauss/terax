import { afterEach, expect, it, vi } from "vitest";
import { native } from "@/modules/ai/lib/native";
import { ShellExecution } from "@/modules/ai/lib/shellExecution";

afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("closes admission when cancelled during opening and never launches the command", async () => {
  const opening = deferred();
  vi.spyOn(native, "shellOpenExecution").mockReturnValue(opening.promise);
  const stop = vi.spyOn(native, "shellStopExecution").mockResolvedValue();
  const close = vi.spyOn(native, "shellCloseExecution").mockResolvedValue();
  const controller = new AbortController();
  const execution = new ShellExecution("owner", controller.signal, "k7m3");
  const launch = vi.fn();
  const result = execution.run(launch);
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  opening.resolve();
  await rejected;
  await execution.close();
  await execution.close();
  expect(launch).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledExactlyOnceWith("owner", execution.id);
  expect(close).toHaveBeenCalledOnce();
});

it("stops before waiting for native work and closes only after its result settles", async () => {
  const command = deferred();
  vi.spyOn(native, "shellOpenExecution").mockResolvedValue();
  const stop = vi
    .spyOn(native, "shellStopExecution")
    .mockImplementation(async () => command.resolve());
  const close = vi.spyOn(native, "shellCloseExecution").mockResolvedValue();
  const controller = new AbortController();
  const execution = new ShellExecution("owner", controller.signal);
  const launch = vi.fn(() => command.promise);
  const result = execution.run(launch);
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
  controller.abort();
  await execution.close();
  await result;
  expect(stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it("preserves cleanup failure when cancellation arrives during normal closing", async () => {
  vi.spyOn(native, "shellOpenExecution").mockResolvedValue();
  vi.spyOn(native, "shellStopExecution").mockRejectedValue(
    new Error("cannot terminate"),
  );
  const close = vi.spyOn(native, "shellCloseExecution").mockResolvedValue();
  const controller = new AbortController();
  const execution = new ShellExecution("owner", controller.signal);
  const command = deferred();
  const launch = vi.fn(() => command.promise);
  const result = execution.run(launch);
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
  const closing = execution.close();
  controller.abort();
  command.resolve();
  await result;
  await expect(closing).rejects.toThrow("cannot terminate");
  expect(close).toHaveBeenCalledOnce();
});

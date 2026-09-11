import { beforeEach, expect, it, vi } from "vitest";
import { createProviderConnection } from "@/modules/ai/providerRegistry";
import { createTextGenerationTask } from "./textGeneration";

const io = vi.hoisted(() => ({ build: vi.fn(), generate: vi.fn() }));
vi.mock("@/modules/ai/lib/providerRuntime", () => ({
  buildLanguageModel: io.build,
}));
vi.mock("ai", () => ({ generateText: io.generate }));
beforeEach(() => vi.resetAllMocks());

it("does not send a request when cancellation occurs during model preparation", async () => {
  let finish!: () => void;
  io.build.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({});
      }),
  );
  const abort = new AbortController();
  const task = createTextGenerationTask(
    {
      connection: createProviderConnection({
        provider: "deepseek",
        instanceId: "builtin:deepseek",
        credentialValue: "test",
      }),
      modelId: "test",
    },
    { maxRetries: 0, signal: abort.signal },
  );
  const request = task.generate({
    instructions: "Complete",
    prompt: "const a =",
  });
  const rejected = expect(request).rejects.toMatchObject({
    name: "AbortError",
  });
  abort.abort();
  finish();
  await rejected;
  await expect(
    task.generate({ instructions: "Complete", prompt: "next" }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(io.generate).not.toHaveBeenCalled();
});

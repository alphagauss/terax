import { beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/lib/nativeHost", () => ({ invokeNative: invoke }));
beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
});

it("shares the initial read and only revises materially changed agent configurations", async () => {
  const { readAgentConfiguration, publishAgentConfigurations } = await import(
    "./agentConfiguration"
  );
  invoke.mockResolvedValue({
    "agent:builtin:main": { instructions: "First", tools: [] },
  });
  const [first, concurrent] = await Promise.all([
    readAgentConfiguration("builtin:main"),
    readAgentConfiguration("builtin:main"),
  ]);
  expect(concurrent).toBe(first);
  expect(await readAgentConfiguration("builtin:main")).toBe(first);
  expect(invoke).toHaveBeenCalledTimes(1);
  publishAgentConfigurations([
    { ...first, instructions: " First\r\n", description: "New description" },
  ]);
  expect((await readAgentConfiguration(first.id)).revision).toBe(
    first.revision,
  );
  publishAgentConfigurations([{ ...first, instructions: "Second" }]);
  const second = await readAgentConfiguration(first.id);
  expect(second.revision).toBeGreaterThan(first.revision);
  expect(first.instructions).toBe("First");
  publishAgentConfigurations([{ ...second, tools: ["grep"] }]);
  expect((await readAgentConfiguration(first.id)).revision).toBeGreaterThan(
    second.revision,
  );
  publishAgentConfigurations([]);
  await expect(readAgentConfiguration(first.id)).rejects.toThrow("unavailable");
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("does not overwrite a newer published configuration with an in-flight initial read", async () => {
  const { readAgentConfiguration, publishAgentConfigurations } = await import(
    "./agentConfiguration"
  );
  const { MAIN_AGENT } = await import("./agentDefinition");
  let resolve!: (value: unknown) => void;
  invoke.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = readAgentConfiguration(MAIN_AGENT.id);
  publishAgentConfigurations([{ ...MAIN_AGENT, instructions: "Published" }]);
  resolve({});
  expect((await pending).instructions).toBe("Published");
});

it("retries initial read failures", async () => {
  const { readAgentConfiguration } = await import("./agentConfiguration");
  invoke.mockRejectedValueOnce(new Error("IO error")).mockResolvedValueOnce({});
  await expect(readAgentConfiguration("builtin:main")).rejects.toThrow(
    "IO error",
  );
  expect((await readAgentConfiguration("builtin:main")).id).toBe(
    "builtin:main",
  );
  expect(invoke).toHaveBeenCalledTimes(2);
});

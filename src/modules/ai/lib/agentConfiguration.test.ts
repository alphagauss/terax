import { beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/lib/nativeHost", () => ({ invokeNative: invoke }));
beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
});

it("revises effective tools without changing saved selections or previous snapshots", async () => {
  const { publishAgentConfigurations, readAgentConfiguration } = await import(
    "./agentConfiguration"
  );
  const { MAIN_AGENT } = await import("./agentDefinition");
  const { resolveToolAvailability } = await import("./toolAvailability");
  const agent = {
    ...MAIN_AGENT,
    tools: ["read_file", "web_search", "web_fetch"] as const,
  };
  const raw = { ...agent, tools: [...agent.tools] };
  publishAgentConfigurations([raw], resolveToolAvailability({}));
  const disabled = await readAgentConfiguration(raw.id);
  expect(disabled.tools).toEqual(["read_file"]);
  publishAgentConfigurations(
    [raw],
    resolveToolAvailability({ "web.searchProvider": "deepseek" }),
  );
  const enabled = await readAgentConfiguration(raw.id);
  expect(enabled.tools).toEqual(["read_file", "web_search"]);
  expect(enabled.revision).toBeGreaterThan(disabled.revision);
  expect(disabled.tools).toEqual(["read_file"]);
  publishAgentConfigurations(
    [raw],
    resolveToolAvailability({
      "web.searchProvider": "deepseek",
      theme: "changed",
    }),
  );
  expect((await readAgentConfiguration(raw.id)).revision).toBe(
    enabled.revision,
  );
  publishAgentConfigurations([raw], resolveToolAvailability({}));
  expect((await readAgentConfiguration(raw.id)).tools).toEqual(["read_file"]);
  expect(raw.tools).toEqual(["read_file", "web_search", "web_fetch"]);
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
  expect(invoke).toHaveBeenCalledTimes(2);
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
  expect(invoke).toHaveBeenCalledTimes(2);
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
  invoke.mockRejectedValueOnce(new Error("IO error")).mockResolvedValue({});
  await expect(readAgentConfiguration("builtin:main")).rejects.toThrow(
    "IO error",
  );
  expect((await readAgentConfiguration("builtin:main")).id).toBe(
    "builtin:main",
  );
  expect(invoke).toHaveBeenCalledTimes(4);
});

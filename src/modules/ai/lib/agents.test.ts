import { beforeEach, describe, expect, it, vi } from "vitest";
const shared = vi.hoisted(() => ({ read: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/sharedStore", () => ({
  readSharedStore: shared.read,
  setSharedStoreKey: shared.set,
}));
import {
  loadAgents,
  saveAgent,
  MAIN_AGENT,
  CHANNEL_AGENT,
  snapshotAgent,
} from "./agents";
import { parseWorkspaceFiles, parseSessionAgent } from "./agentDefinition";

describe("agent configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared.read.mockResolvedValue({});
  });

  it("resolves two defaults without creating stored records", async () => {
    expect(await loadAgents()).toEqual([MAIN_AGENT, CHANNEL_AGENT]);
    expect(shared.set).not.toHaveBeenCalled();
    expect(MAIN_AGENT.instructions).toContain(":line_number");
    expect(CHANNEL_AGENT.instructions).not.toContain("# Local file references");
    expect(CHANNEL_AGENT.tools).not.toContain("get_terminal_output");
  });

  it("serializes refreshes so a pending old read cannot overwrite a saved configuration", async () => {
    const { readAgentConfiguration } = await import("./agentConfiguration");
    let resolve!: (value: unknown) => void;
    shared.read
      .mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      )
      .mockResolvedValueOnce({
        "agent:builtin:main": { instructions: "Saved" },
      });
    const first = loadAgents();
    const second = loadAgents();
    await vi.waitFor(() => expect(shared.read).toHaveBeenCalledTimes(1));
    resolve({ "agent:builtin:main": { instructions: "Old" } });
    await first;
    expect((await second)[0].instructions).toBe("Saved");
    expect((await readAgentConfiguration(MAIN_AGENT.id)).instructions).toBe(
      "Saved",
    );
    shared.read
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce({});
    await expect(loadAgents()).rejects.toThrow("read failed");
    expect(await loadAgents()).toEqual([MAIN_AGENT, CHANNEL_AGENT]);
  });

  it("keeps explicit empty overrides and removes defaults from saved records", async () => {
    await saveAgent({
      ...MAIN_AGENT,
      instructions: "",
      tools: [],
      workspaceFiles: [],
    });
    expect(shared.set).toHaveBeenLastCalledWith(
      "ai-agents",
      "agent:builtin:main",
      { instructions: "", tools: [], workspaceFiles: [] },
    );
    shared.read.mockResolvedValue({
      "agent:builtin:main": { instructions: "", tools: [], workspaceFiles: [] },
    });
    expect((await loadAgents())[0]).toMatchObject({
      instructions: "",
      tools: [],
      workspaceFiles: [],
    });
    await saveAgent(MAIN_AGENT);
    expect(shared.set).toHaveBeenLastCalledWith(
      "ai-agents",
      "agent:builtin:main",
      {},
    );
  });

  it("persists independent complete custom definitions and rejects incomplete old records", async () => {
    const custom = { ...MAIN_AGENT, id: "a-custom", name: "Custom" };
    await saveAgent(custom);
    expect(shared.set).toHaveBeenLastCalledWith(
      "ai-agents",
      "agent:a-custom",
      custom,
    );
    shared.read.mockResolvedValue({
      "agent:a-custom": custom,
      "agent:old": { id: "old", name: "Old", instructions: "Old" },
    });
    expect(await loadAgents()).toEqual([MAIN_AGENT, CHANNEL_AGENT, custom]);
  });

  it("does not grant unsupported Channel tools from a hand-edited record", async () => {
    shared.read.mockResolvedValue({
      "agent:builtin:channel": { tools: ["get_terminal_output", "grep"] },
    });
    expect((await loadAgents())[1].tools).toEqual(["grep"]);
  });

  it("stores only the session identity and propagates save failure", async () => {
    expect(snapshotAgent(MAIN_AGENT)).toEqual({
      id: MAIN_AGENT.id,
      name: MAIN_AGENT.name,
      icon: MAIN_AGENT.icon,
    });
    expect(() => parseSessionAgent(undefined)).toThrow();
    shared.set.mockRejectedValueOnce(new Error("disk full"));
    await expect(saveAgent(MAIN_AGENT)).rejects.toThrow("disk full");
  });
});

describe("workspace instruction paths", () => {
  it("preserves order, normalizes separators, and allows an empty list", () => {
    expect(
      parseWorkspaceFiles(
        " AGENTS.md, docs/rules.md, ./AGENTS.md, docs\\more.md,, ",
      ),
    ).toEqual(["AGENTS.md", "docs/rules.md", "docs/more.md"]);
    expect(parseWorkspaceFiles(" , ")).toEqual([]);
  });
  it.each([
    "../secret",
    "/tmp/rules",
    "D:/rules",
    "docs/../../rules",
    "*.md",
    ".",
    "//server/share",
  ])("rejects unsupported path %s", (path) => {
    expect(() => parseWorkspaceFiles(path)).toThrow();
  });
});

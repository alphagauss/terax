/**
 * 本文件测试固定主 Agent、自定义定义迁移和会话快照解析。
 * 锁定旧定义补齐工具、无效选择回退主 Agent以及会话快照独立复制。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("@/lib/sharedStore", () => ({
  readSharedStore: shared.read,
  setSharedStoreKey: vi.fn(),
}));

import {
  type Agent,
  findAgent,
  loadAgents,
  MAIN_AGENT,
  parseSessionAgent,
  snapshotAgent,
} from "./agents";
import { AGENT_TOOL_IDS } from "./agentTools";

const custom: Agent = {
  id: "a-1",
  name: "Mine",
  description: "Focused agent",
  instructions: "Inspect carefully.",
  icon: "spark",
  tools: ["read_file", "grep"],
};

describe("agent definitions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps one fixed main agent and falls back to it", () => {
    expect(findAgent([custom], "a-1")).toBe(custom);
    expect(findAgent([custom], "missing")).toMatchObject({
      id: MAIN_AGENT.id,
      name: "Terax",
    });
  });

  it("loads old custom agents with the complete tool set", async () => {
    shared.read.mockResolvedValue({
      "agent:a-1": {
        id: "a-1",
        name: "Mine",
        description: "Focused agent",
        instructions: "Inspect carefully.",
        icon: "spark",
        builtIn: false,
      },
      "agent:broken": { id: "builtin:legacy" },
      "agent:mismatched": {
        id: "a-other",
        name: "Other",
        description: "Wrong key",
        instructions: "Should be ignored.",
        icon: "spark",
      },
    });

    await expect(loadAgents()).resolves.toEqual([
      { ...custom, tools: [...AGENT_TOOL_IDS] },
    ]);
  });

  it("copies snapshots and treats legacy session metadata as main", () => {
    const snapshot = snapshotAgent(custom);
    custom.tools.push("find_files");

    expect(snapshot.tools).toEqual(["read_file", "grep"]);
    expect(parseSessionAgent(undefined).id).toBe(MAIN_AGENT.id);
    expect(
      parseSessionAgent({
        id: MAIN_AGENT.id,
        name: "Modified main",
        instructions: "Override the fixed main agent.",
        icon: "security",
        tools: [],
      }),
    ).toEqual(snapshotAgent(findAgent([], null)));
  });
});

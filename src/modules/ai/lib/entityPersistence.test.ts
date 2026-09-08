/**
 * 本文件测试 AI 自定义实体使用按记录持久化接口。
 * Agent 删除必须进入 Rust 级联命令，片段仍直接修改共享存储记录。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  read: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}));
const invoke = vi.hoisted(() => vi.fn());

vi.mock("@/lib/sharedStore", () => ({
  readSharedStore: shared.read,
  setSharedStoreKey: shared.set,
  deleteSharedStoreKey: shared.remove,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { deleteCustomAgent, saveAgent, type Agent } from "./agents";
import { deleteSnippet, upsertSnippet, type Snippet } from "./snippets";

describe("per-record AI entity persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared.set.mockResolvedValue(undefined);
    shared.remove.mockResolvedValue(undefined);
    invoke.mockResolvedValue([]);
  });

  it("upserts and deletes only the target agent record", async () => {
    const agent: Agent = {
      id: "agent-one",
      name: "One",
      description: "test",
      instructions: "test",
      workspaceFiles: ["AGENTS.md"],
      icon: "coder",
      tools: ["read_file"],
    };

    await saveAgent(agent);
    await deleteCustomAgent(agent.id);

    expect(shared.set).toHaveBeenCalledWith(
      "ai-agents",
      "agent:agent-one",
      agent,
    );
    expect(invoke).toHaveBeenCalledWith("ai_agent_delete", {
      agentId: "agent-one",
    });
    expect(shared.read).not.toHaveBeenCalled();
  });

  it("upserts and deletes only the target snippet record", async () => {
    const snippet: Snippet = {
      id: "snippet-one",
      handle: "one",
      name: "One",
      description: "test",
      content: "content",
    };

    await upsertSnippet(snippet);
    await deleteSnippet(snippet.id);

    expect(shared.set).toHaveBeenCalledWith(
      "ai-snippets",
      "snippet:snippet-one",
      snippet,
    );
    expect(shared.remove).toHaveBeenCalledWith(
      "ai-snippets",
      "snippet:snippet-one",
    );
    expect(shared.read).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  read: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}));
const workspace = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("@/lib/sharedStore", () => ({
  readSharedStore: shared.read,
  setSharedStoreKey: shared.set,
  deleteSharedStoreKey: shared.remove,
}));

vi.mock("@/modules/workspace-process", () => ({
  getWorkspaceValue: workspace.get,
  setWorkspaceValue: workspace.set,
}));

import {
  deleteCustomAgent,
  saveActiveAgentId,
  upsertCustomAgent,
  type Agent,
} from "./agents";
import { deleteSnippet, upsertSnippet, type Snippet } from "./snippets";

describe("per-record AI entity persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared.set.mockResolvedValue(undefined);
    shared.remove.mockResolvedValue(undefined);
    workspace.set.mockResolvedValue(undefined);
  });

  it("upserts and deletes only the target agent record", async () => {
    const agent: Agent = {
      id: "agent-one",
      name: "One",
      description: "test",
      instructions: "test",
      icon: "coder",
      builtIn: false,
    };

    await upsertCustomAgent(agent);
    await deleteCustomAgent(agent.id);

    expect(shared.set).toHaveBeenCalledWith(
      "ai-agents",
      "agent:agent-one",
      agent,
    );
    expect(shared.remove).toHaveBeenCalledWith(
      "ai-agents",
      "agent:agent-one",
    );
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

  it("persists the active agent only in the current Workspace", async () => {
    await saveActiveAgentId("agent-one");

    expect(workspace.set).toHaveBeenCalledWith(
      "ai:activeAgentId",
      "agent-one",
    );
    expect(shared.set).not.toHaveBeenCalled();
  });
});

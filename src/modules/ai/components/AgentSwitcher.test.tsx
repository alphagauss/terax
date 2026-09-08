// @vitest-environment happy-dom
/**
 * 本文件测试 Agent 选择器的草稿与持久化会话边界。
 * 锁定空白草稿可选择 Agent，而已开始会话只显示不可交互的冻结身份。
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/settings/openSettingsWindow", () => ({
  openSettingsWindow: vi.fn(),
}));

import { MAIN_AGENT_ID } from "../lib/agents";
import { useAgentsStore } from "../store/agentsStore";
import { useChatStore } from "../store/chatStore";
import { AgentSwitcher } from "./AgentSwitcher";

const customAgent = {
  id: "a-review",
  name: "Reviewer",
  description: "Review code",
  instructions: "Review carefully.",
  workspaceFiles: ["AGENTS.md"],
  icon: "reviewer" as const,
  tools: ["read_file" as const, "grep" as const],
};

afterEach(() => {
  useAgentsStore.setState({
    agents: [],
    draftAgentId: MAIN_AGENT_ID,
  });
  useChatStore.setState({ sessions: [], activeSessionId: null });
  document.body.replaceChildren();
});

describe("AgentSwitcher", () => {
  it("allows selection only for an unsent draft", async () => {
    useAgentsStore.setState({
      agents: [customAgent],
      draftAgentId: customAgent.id,
    });
    useChatStore.setState({
      sessions: [],
      activeSessionId: "44444444-4444-4444-8444-444444444444",
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<AgentSwitcher />));

    expect(container.querySelector("button")?.textContent).toContain(
      "Reviewer",
    );
    await act(async () => root.unmount());
  });

  it("renders a locked identity for a persisted session", async () => {
    useAgentsStore.setState({ agents: [customAgent] });
    useChatStore.setState({
      activeSessionId: "55555555-5555-4555-8555-555555555555",
      sessions: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          title: "Review",
          createdAt: 1,
          updatedAt: 2,
          environmentKey: "local",
          cwd: "D:/workspace",
          agentId: customAgent.id,
          agentName: customAgent.name,
          agentIcon: customAgent.icon,
        },
      ],
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<AgentSwitcher />));

    expect(container.textContent).toContain("Reviewer");
    expect(container.querySelector("button")).toBeNull();
    await act(async () => root.unmount());
  });
});

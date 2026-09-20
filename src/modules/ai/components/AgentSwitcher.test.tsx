// @vitest-environment happy-dom
/**
 * 本文件测试 Agent 选择器的草稿与持久化会话边界。
 * 空白草稿可选择 Agent，而已开始会话只显示不可交互的冻结身份。
 */

import { preloadEn } from "@/i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/settings/openSettingsWindow", () => ({
  openSettingsWindow: vi.fn(),
}));

import { MAIN_AGENT_ID } from "../lib/agents";
import { useAgentsStore } from "../store/agentsStore";
import { useChatStore } from "../store/chatStore";
import { AgentPicker, SessionAgentIdentity } from "./AgentSwitcher";

const customAgent = {
  id: "a-review",
  name: "Reviewer",
  description: "Review code",
  instructions: "Review carefully.",
  workspaceFiles: ["AGENTS.md"],
  icon: "reviewer" as const,
  tools: ["read_file" as const, "grep" as const],
};
const persistedSessionId = "55555555-5555-4555-8555-555555555555";

afterEach(() => {
  useAgentsStore.setState({
    agents: [],
    draftAgentId: MAIN_AGENT_ID,
  });
  useChatStore.setState({ sessions: [], activeSessionId: null });
  document.body.replaceChildren();
});

describe("Agent identity controls", () => {
  it("shows the full selectable identity only for an unsent draft", async () => {
    await preloadEn();
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

    await act(async () => root.render(<AgentPicker />));

    const trigger = container.querySelector("button");
    expect(trigger?.textContent).toContain("Reviewer");
    expect(trigger?.getAttribute("aria-label")).toContain("Reviewer");
    await act(async () => root.unmount());
  });

  it("renders a locked identity for a persisted session", async () => {
    await preloadEn();
    useAgentsStore.setState({ agents: [customAgent] });
    useChatStore.setState({
      activeSessionId: persistedSessionId,
      sessions: [
        {
          id: persistedSessionId,
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

    await act(async () =>
      root.render(
        <>
          <AgentPicker />
          <SessionAgentIdentity sessionId={persistedSessionId} />
        </>,
      ),
    );

    expect(container.textContent).toBe("Reviewer");
    expect(container.querySelector('[aria-label*="Reviewer"]')).not.toBeNull();
    expect(container.querySelector("button")).toBeNull();
    await act(async () => root.unmount());
  });
});

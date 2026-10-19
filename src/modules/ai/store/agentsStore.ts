/**
 * 本文件管理跨 Workspace 共享的智能体定义和当前未发送草稿的选择。
 * 草稿选择只存在于当前进程，会话固定身份，新轮检查内存配置版本。
 */

import { onSharedStoreChange } from "@/lib/sharedStore";
import { create } from "zustand";
import {
  deleteCustomAgent,
  findAgent,
  loadAgents,
  MAIN_AGENT_ID,
  BUILTIN_AGENTS,
  CHANNEL_AGENT_ID,
  newAgentId,
  saveAgent,
  type Agent,
} from "../lib/agents";

type AgentsState = {
  hydrated: boolean;
  agents: Agent[];
  draftAgentId: string;
  hydrate: () => Promise<void>;
  setDraftAgentId: (id: string) => void;
  resetDraftAgent: () => void;
  selectedDraftAgent: () => Agent;
  upsert: (agent: Agent) => Promise<void>;
  remove: (id: string) => Promise<string[]>;
};

let initialization: Promise<void> | undefined;

/** 智能体状态；内置与自定义定义统一显示，只有自定义定义可删除。 */
export const useAgentsStore = create<AgentsState>((set, get) => ({
  hydrated: false,
  agents: BUILTIN_AGENTS.map((agent) => ({
    ...agent,
    tools: [...agent.tools],
    workspaceFiles: [...agent.workspaceFiles],
  })),
  draftAgentId: MAIN_AGENT_ID,
  hydrate: () => {
    initialization ??= (async () => {
      const agents = await loadAgents();
      set({ agents, hydrated: true });

      await onSharedStoreChange("settings", async () => {
        // 只发布有效运行配置，保留编辑中的原始工具勾选。
        await loadAgents();
      });

      await onSharedStoreChange("ai-agents", async () => {
        const fresh = await loadAgents();
        const draftAgentId = fresh.some(
          (agent) => agent.id === get().draftAgentId,
        )
          ? get().draftAgentId
          : MAIN_AGENT_ID;
        set({ agents: fresh, draftAgentId });
        const { useChatStore } = await import("./chatStore");
        if (useChatStore.getState().sessionsHydrated) {
          await useChatStore.getState().refreshSessions();
        }
      });
    })().catch((error) => {
      initialization = undefined;
      set({ hydrated: false });
      throw error;
    });
    return initialization;
  },
  setDraftAgentId: (id) => {
    set({
      draftAgentId: findAgent(
        get().agents,
        id === CHANNEL_AGENT_ID ? MAIN_AGENT_ID : id,
      ).id,
    });
  },
  resetDraftAgent: () => set({ draftAgentId: MAIN_AGENT_ID }),
  selectedDraftAgent: () => findAgent(get().agents, get().draftAgentId),
  upsert: async (agent) => {
    await saveAgent(agent);
    set({ agents: await loadAgents() });
  },
  remove: async (id) => {
    const deletedSessionIds = await deleteCustomAgent(id);
    const agents = await loadAgents();
    set({
      agents,
      draftAgentId:
        get().draftAgentId === id ? MAIN_AGENT_ID : get().draftAgentId,
    });
    const { useChatStore } = await import("./chatStore");
    if (useChatStore.getState().sessionsHydrated) {
      await useChatStore.getState().refreshSessions();
    }
    return deletedSessionIds;
  },
}));

export { newAgentId };

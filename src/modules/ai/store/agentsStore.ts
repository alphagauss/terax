/**
 * 本文件管理跨 Workspace 共享的 Custom Agent 定义和当前未发送草稿的选择。
 * 草稿选择只存在于当前进程，首次发送后由会话快照接管。
 */

import { onSharedStoreChange } from "@/lib/sharedStore";
import { create } from "zustand";
import {
  deleteCustomAgent,
  findAgent,
  loadAgents,
  MAIN_AGENT_ID,
  newAgentId,
  upsertCustomAgent,
  type Agent,
} from "../lib/agents";

type AgentsState = {
  hydrated: boolean;
  customAgents: Agent[];
  draftAgentId: string;
  hydrate: () => Promise<void>;
  setDraftAgentId: (id: string) => void;
  resetDraftAgent: () => void;
  selectedDraftAgent: () => Agent;
  upsert: (agent: Agent) => void;
  remove: (id: string) => Promise<string[]>;
};

let initialized = false;

/** Custom Agent 状态；固定主 Agent 不进入持久化列表。 */
export const useAgentsStore = create<AgentsState>((set, get) => ({
  hydrated: false,
  customAgents: [],
  draftAgentId: MAIN_AGENT_ID,
  hydrate: async () => {
    if (initialized) return;
    initialized = true;
    const customAgents = await loadAgents();
    set({ customAgents, hydrated: true });

    void onSharedStoreChange("ai-agents", async () => {
      const fresh = await loadAgents();
      const draftAgentId = fresh.some(
        (agent) => agent.id === get().draftAgentId,
      )
        ? get().draftAgentId
        : MAIN_AGENT_ID;
      set({ customAgents: fresh, draftAgentId });
      const { useChatStore } = await import("./chatStore");
      if (useChatStore.getState().sessionsHydrated) {
        await useChatStore.getState().refreshSessions();
      }
    });
  },
  setDraftAgentId: (id) => {
    set({ draftAgentId: findAgent(get().customAgents, id).id });
  },
  resetDraftAgent: () => set({ draftAgentId: MAIN_AGENT_ID }),
  selectedDraftAgent: () => findAgent(get().customAgents, get().draftAgentId),
  upsert: (agent) => {
    const list = get().customAgents;
    const index = list.findIndex((item) => item.id === agent.id);
    const next =
      index === -1
        ? [...list, agent]
        : list.map((item) => (item.id === agent.id ? agent : item));
    set({ customAgents: next });
    void upsertCustomAgent(agent);
  },
  remove: async (id) => {
    const deletedSessionIds = await deleteCustomAgent(id);
    const customAgents = get().customAgents.filter((agent) => agent.id !== id);
    set({
      customAgents,
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

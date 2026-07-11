import { onSharedStoreChange } from "@/lib/sharedStore";
import { create } from "zustand";
import {
  BUILTIN_AGENTS,
  deleteCustomAgent,
  loadAgents,
  newAgentId,
  saveActiveAgentId,
  upsertCustomAgent,
  type Agent,
} from "../lib/agents";

type AgentsState = {
  hydrated: boolean;
  customAgents: Agent[];
  activeId: string;
  /** All agents, builtin first. */
  all: () => Agent[];
  hydrate: () => Promise<void>;
  setActiveId: (id: string) => void;
  upsert: (agent: Agent) => void;
  remove: (id: string) => void;
};

let initialized = false;

export const useAgentsStore = create<AgentsState>((set, get) => ({
  hydrated: false,
  customAgents: [],
  activeId: BUILTIN_AGENTS[0].id,
  all: () => [...BUILTIN_AGENTS, ...get().customAgents],
  hydrate: async () => {
    if (initialized) return;
    initialized = true;
    const { custom, activeId } = await loadAgents();
    set({ customAgents: custom, activeId, hydrated: true });

    void onSharedStoreChange("ai-agents", async () => {
      const fresh = await loadAgents();
      set({ customAgents: fresh.custom });
    });
  },
  setActiveId: (id) => {
    set({ activeId: id });
    void saveActiveAgentId(id);
  },
  upsert: (agent) => {
    if (agent.builtIn) return;
    const list = get().customAgents;
    const idx = list.findIndex((a) => a.id === agent.id);
    const next =
      idx === -1 ? [...list, agent] : list.map((a) => (a.id === agent.id ? agent : a));
    set({ customAgents: next });
    void upsertCustomAgent(agent);
  },
  remove: (id) => {
    const list = get().customAgents.filter((a) => a.id !== id);
    set({ customAgents: list });
    let active = get().activeId;
    if (active === id) {
      active = BUILTIN_AGENTS[0].id;
      set({ activeId: active });
      void saveActiveAgentId(active);
    }
    void deleteCustomAgent(id);
  },
}));

export { newAgentId };

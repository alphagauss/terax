import { create } from "zustand";
import type { Todo } from "../lib/todos";

type TodosState = {
  /** Map of sessionId -> todos. */
  bySession: Record<string, Todo[]>;
  /** Set of sessionIds whose todos were hydrated. */
  hydrated: Set<string>;
  hydrate: (sessionId: string) => Promise<void>;
  setTodos: (sessionId: string, todos: Todo[]) => void;
  clearSession: (sessionId: string) => Promise<void>;
};

export const useTodosStore = create<TodosState>((set, get) => ({
  bySession: {},
  hydrated: new Set(),

  async hydrate(sessionId) {
    if (get().hydrated.has(sessionId)) return;
    set((s) => {
      const nextHydrated = new Set(s.hydrated);
      nextHydrated.add(sessionId);
      return {
        bySession: { ...s.bySession, [sessionId]: [] },
        hydrated: nextHydrated,
      };
    });
  },

  setTodos(sessionId, todos) {
    set((s) => ({
      bySession: { ...s.bySession, [sessionId]: todos },
    }));
  },

  async clearSession(sessionId) {
    set((s) => {
      const next = { ...s.bySession };
      delete next[sessionId];
      const nextHydrated = new Set(s.hydrated);
      nextHydrated.delete(sessionId);
      return { bySession: next, hydrated: nextHydrated };
    });
  },
}));

export function seedTodos(sessionId: string, todos: Todo[]): void {
  useTodosStore.setState((state) => {
    const hydrated = new Set(state.hydrated);
    hydrated.add(sessionId);
    return {
      bySession: { ...state.bySession, [sessionId]: todos },
      hydrated,
    };
  });
}

export function getTodos(sessionId: string | null): Todo[] {
  if (!sessionId) return [];
  return useTodosStore.getState().bySession[sessionId] ?? [];
}

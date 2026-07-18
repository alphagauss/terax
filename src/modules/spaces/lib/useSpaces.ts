import { create } from "zustand";
import {
  deleteSpaceData,
  newSpaceId,
  type SpaceMeta,
  saveActiveId,
  saveSpacesList,
} from "./store";

type CreateInput = {
  id?: string;
  name: string;
  root: string | null;
};

type State = {
  spaces: SpaceMeta[];
  activeId: string | null;
  hydrated: boolean;
  hydrate: (spaces: SpaceMeta[], activeId: string | null) => void;
  create: (input: CreateInput) => SpaceMeta;
  rename: (id: string, name: string) => void;
  setColor: (id: string, color: number | undefined) => void;
  reorder: (orderedIds: string[]) => void;
  remove: (id: string) => string | null;
  setActive: (id: string) => void;
};

export const useSpaces = create<State>((set, get) => ({
  spaces: [],
  activeId: null,
  hydrated: false,
  hydrate: (spaces, activeId) => {
    set({ spaces, activeId, hydrated: true });
  },

  create: (input) => {
    const now = Date.now();
    const meta: SpaceMeta = {
      id: input.id ?? newSpaceId(),
      name: input.name,
      root: input.root,
      createdAt: now,
      updatedAt: now,
    };
    const spaces = [...get().spaces, meta];
    set({ spaces });
    void saveSpacesList(spaces);
    return meta;
  },

  rename: (id, name) => {
    const spaces = get().spaces.map((s) =>
      s.id === id ? { ...s, name, updatedAt: Date.now() } : s,
    );
    set({ spaces });
    void saveSpacesList(spaces);
  },

  setColor: (id, color) => {
    const spaces = get().spaces.map((s) =>
      s.id === id ? { ...s, color, updatedAt: Date.now() } : s,
    );
    set({ spaces });
    void saveSpacesList(spaces);
  },

  reorder: (orderedIds) => {
    const byId = new Map(get().spaces.map((s) => [s.id, s]));
    const next: SpaceMeta[] = [];
    for (const id of orderedIds) {
      const s = byId.get(id);
      if (s) next.push(s);
    }
    for (const s of get().spaces) {
      if (!next.includes(s)) next.push(s);
    }
    if (next.length !== get().spaces.length) return;
    set({ spaces: next });
    void saveSpacesList(next);
  },

  remove: (id) => {
    const prev = get();
    const spaces = prev.spaces.filter((s) => s.id !== id);
    let activeId = prev.activeId;
    if (activeId === id) activeId = spaces[0]?.id ?? null;
    set({ spaces, activeId });
    void saveSpacesList(spaces);
    void deleteSpaceData(id);
    if (activeId !== prev.activeId) void saveActiveId(activeId);
    return activeId;
  },

  setActive: (id) => {
    if (get().activeId === id) return;
    set({ activeId: id });
    void saveActiveId(id);
  },
}));

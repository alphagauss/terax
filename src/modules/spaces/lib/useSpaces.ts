/** Space 元数据拥有目录锁定和命名；终端跟随目录不写入持久化根。 */
import { create } from "zustand";
import { pathBasename, normalizePathForIdentity } from "@/lib/utils";
import { documentPathIdentity } from "@/lib/pathIdentity";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { DEFAULT_SPACE_ID } from "@/modules/workbench/types";
import {
  deleteSpaceData,
  newSpaceId,
  type SpaceMeta,
  saveActiveId,
  saveSpacesList,
} from "./store";

type CreateInput = {
  name: string;
  root: string | null;
};

/** 保留文件系统根的分隔符，消除目录末尾分隔符引起的重复切换。 */
export function normalizeSpaceRoot(path: string): string {
  const normalized = normalizePathForIdentity(path);
  return (
    normalized.replace(/\/+$/, "") +
    (/^(?:\/|[a-z]:\/)$/i.test(normalized) ? "/" : "")
  );
}

/** Default 的身份不依赖显示名称或持久化顺序。 */
export function createDefaultSpace(root: string | null = null): SpaceMeta {
  return {
    id: DEFAULT_SPACE_ID,
    name: "Default",
    root,
    rootLocked: false,
    autoName: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function withDefaultSpace(spaces: SpaceMeta[]): SpaceMeta[] {
  const current = spaces.find((space) => space.id === DEFAULT_SPACE_ID);
  return [
    current ?? createDefaultSpace(),
    ...spaces.filter((space) => space.id !== DEFAULT_SPACE_ID),
  ];
}

type State = {
  spaces: SpaceMeta[];
  activeId: string | null;
  hydrated: boolean;
  hydrate: (spaces: SpaceMeta[], activeId: string | null) => void;
  create: (input: CreateInput) => SpaceMeta;
  rename: (id: string, name: string) => void;
  setRoot: (id: string, root: string) => void;
  setRootLocked: (
    id: string,
    locked: boolean,
    currentRoot: string | null,
  ) => void;
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
    set({ spaces: withDefaultSpace(spaces), activeId, hydrated: true });
  },

  create: (input) => {
    const now = Date.now();
    const meta: SpaceMeta = {
      id: newSpaceId(),
      name: input.root ? pathBasename(input.root) : input.name,
      root: input.root ? normalizeSpaceRoot(input.root) : null,
      rootLocked: true,
      autoName: true,
      createdAt: now,
      updatedAt: now,
    };
    const spaces = [...get().spaces, meta];
    set({ spaces });
    void saveSpacesList(spaces);
    return meta;
  },

  rename: (id, name) => {
    if (id === DEFAULT_SPACE_ID) return;
    const spaces = get().spaces.map((s) =>
      s.id === id ? { ...s, name, autoName: false, updatedAt: Date.now() } : s,
    );
    set({ spaces });
    void saveSpacesList(spaces);
  },

  setRoot: (id, root) => get().setRootLocked(id, true, root),

  setRootLocked: (id, locked, currentRoot) => {
    const current = get().spaces.find((space) => space.id === id);
    if (!current) return;
    const root = locked
      ? currentRoot
        ? normalizeSpaceRoot(currentRoot)
        : null
      : current.root;
    const changed =
      root === null || current.root === null
        ? root !== current.root
        : documentPathIdentity(currentWorkspaceEnv(), root) !==
          documentPathIdentity(
            currentWorkspaceEnv(),
            normalizeSpaceRoot(current.root),
          );
    if (!changed && current.rootLocked === locked) return;
    const spaces = get().spaces.map((space) =>
      space.id === id
        ? {
            ...space,
            root: changed ? root : space.root,
            rootLocked: locked,
            name:
              changed && root && space.autoName && id !== DEFAULT_SPACE_ID
                ? pathBasename(root)
                : space.name,
            updatedAt: Date.now(),
          }
        : space,
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
      if (s && !next.includes(s)) next.push(s);
    }
    for (const s of get().spaces) {
      if (!next.includes(s)) next.push(s);
    }
    if (next.length !== get().spaces.length) return;
    const ordered = withDefaultSpace(next);
    set({ spaces: ordered });
    void saveSpacesList(ordered);
  },

  remove: (id) => {
    const prev = get();
    if (id === DEFAULT_SPACE_ID) return prev.activeId;
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

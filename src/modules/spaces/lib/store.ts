import {
  deleteWorkspaceValue,
  getWorkspaceEntries,
  setWorkspaceValue,
} from "@/modules/workspace-process";
import {
  isSerializedWorkbenchNode,
  type SerializedWorkbenchNode,
} from "./serialize";

export type SpaceMeta = {
  id: string;
  name: string;
  root: string | null;
  color?: number;
  createdAt: number;
  updatedAt: number;
};

export type SpaceState = {
  version: 2;
  workbench: SerializedWorkbenchNode;
};

const KEY_SPACES = "spaces";
const KEY_ACTIVE = "activeSpaceId";
const STATE_PREFIX = "spaceState:";
const stateKey = (id: string) => `${STATE_PREFIX}${id}`;

export type LoadedSpaces = {
  spaces: SpaceMeta[];
  activeId: string | null;
  states: Map<string, SpaceState>;
};

export async function loadAll(): Promise<LoadedSpaces> {
  const entries = getWorkspaceEntries();
  const spaces = (entries.get(KEY_SPACES) as SpaceMeta[] | undefined) ?? [];
  const activeId =
    (entries.get(KEY_ACTIVE) as string | null | undefined) ?? null;
  const states = new Map<string, SpaceState>();
  for (const [key, value] of entries) {
    if (key.startsWith(STATE_PREFIX)) {
      const candidate = value as Partial<SpaceState>;
      if (
        candidate.version === 2 &&
        isSerializedWorkbenchNode(candidate.workbench)
      ) {
        states.set(key.slice(STATE_PREFIX.length), candidate as SpaceState);
      }
    }
  }
  return { spaces, activeId, states };
}

export function saveSpacesList(spaces: SpaceMeta[]): Promise<void> {
  return setWorkspaceValue(KEY_SPACES, spaces);
}

export function saveActiveId(id: string | null): Promise<void> {
  return setWorkspaceValue(KEY_ACTIVE, id);
}

export function saveState(id: string, state: SpaceState): Promise<void> {
  return setWorkspaceValue(stateKey(id), state);
}

export function deleteSpaceData(id: string): Promise<void> {
  return deleteWorkspaceValue(stateKey(id));
}

export function newSpaceId(): string {
  return `sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

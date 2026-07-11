import {
  deleteWorkspaceValue,
  getWorkspaceEntries,
  setWorkspaceValue,
} from "@/modules/workspace-process";
import type { SerializedTab } from "./serialize";

export type SpaceMeta = {
  id: string;
  name: string;
  root: string | null;
  color?: number;
  createdAt: number;
  updatedAt: number;
};

export type SpaceState = {
  tabs: SerializedTab[];
  activeTabIndex: number;
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
  const stored = (entries.get(KEY_SPACES) as
    | (SpaceMeta & { env?: unknown })[]
    | undefined) ?? [];
  const spaces = stored.map(({ env: _legacyEnv, ...space }) => space);
  if (stored.some((space) => "env" in space)) {
    await setWorkspaceValue(KEY_SPACES, spaces);
  }
  const activeId =
    (entries.get(KEY_ACTIVE) as string | null | undefined) ?? null;
  const states = new Map<string, SpaceState>();
  for (const [key, value] of entries) {
    if (key.startsWith(STATE_PREFIX)) {
      states.set(key.slice(STATE_PREFIX.length), value as SpaceState);
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

/**
 * 本文件维护跨 Workspace 进程共享的 SSH 配置、分组和连接状态。
 * 分组只影响配置管理与导航，运行时连接仍由稳定的 profile ID 标识。
 */

import {
  deleteSharedStoreKey,
  mutateSharedStore,
  onSharedStoreChange,
  readSharedStore,
  setSharedStoreKey,
} from "@/lib/sharedStore";
import { create } from "zustand";
import { remoteNative } from "./native";
import { DEFAULT_SSH_GROUP_ID } from "./groups";
import type { ConnectionInfo, SshGroup, SshProfile, SshTunnel } from "./types";

const profileKey = (id: string) => `profile:${id}`;
const groupKey = (id: string) => `group:${id}`;
let subscribed = false;
let loadInFlight: Promise<SshProfile[]> | null = null;

type RemoteState = {
  groups: SshGroup[];
  profiles: SshProfile[];
  statuses: Record<string, ConnectionInfo>;
  loaded: boolean;
  /** 读取并归一化 SSH 配置；常规调用复用已完成或正在进行的加载。 */
  load: (force?: boolean) => Promise<SshProfile[]>;
  saveGroup: (group: SshGroup) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;
  saveProfile: (profile: SshProfile) => Promise<void>;
  saveProfiles: (profiles: SshProfile[]) => Promise<void>;
  deleteProfile: (profileId: string) => Promise<void>;
  setStatus: (info: ConnectionInfo) => void;
};

function removeInlineProxyPassword(value?: string | null): string | null {
  if (!value) return null;
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/@:\s]+):[^@/]*@/i, "$1@");
}

function normalizeProfile(
  profile: SshProfile,
  knownGroupIds: ReadonlySet<string>,
): SshProfile {
  return {
    ...profile,
    groupId: knownGroupIds.has(profile.groupId)
      ? profile.groupId
      : DEFAULT_SSH_GROUP_ID,
    name: profile.name?.trim() || `${profile.username}@${profile.host}`,
    proxyUrl: removeInlineProxyPassword(profile.proxyUrl),
    port: normalizeInteger(profile.port, 1, 65535, 22),
    keepaliveSeconds: normalizeInteger(
      profile.keepaliveSeconds,
      0,
      Number.MAX_SAFE_INTEGER,
      30,
    ),
    reconnectMaxAttempts: normalizeInteger(
      profile.reconnectMaxAttempts,
      1,
      20,
      5,
    ),
    reconnectEnabled: Boolean(profile.reconnectEnabled),
    rootPath: profile.rootPath?.trim() || "~",
    tunnels: (profile.tunnels ?? []).map(normalizeTunnel),
  };
}

/** 将旧 profile 中缺失的隧道字段补为安全的默认值。 */
function normalizeTunnel(tunnel: SshTunnel): SshTunnel {
  return {
    ...tunnel,
    enabled: tunnel.enabled !== false,
    name: tunnel.name?.trim() ?? "",
    bindHost: tunnel.bindHost?.trim() || "127.0.0.1",
    bindPort: normalizeInteger(tunnel.bindPort, 0, 65535, 0),
    targetHost: tunnel.targetHost?.trim() ?? "",
    targetPort: normalizeInteger(tunnel.targetPort, 0, 65535, 0),
  };
}

function normalizeInteger(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export const useRemoteStore = create<RemoteState>((set, get) => ({
  groups: [],
  profiles: [],
  statuses: {},
  loaded: false,
  load: async (force = false) => {
    if (loadInFlight) {
      const profiles = await loadInFlight;
      if (!force) return profiles;
    }
    if (!force && get().loaded) return get().profiles;

    const task = (async () => {
      const values = await readSharedStore("ssh-profiles");
      const groups = Object.entries(values)
        .filter(([key]) => key.startsWith("group:"))
        .map(([, value]) => value as SshGroup)
        .filter(
          (group) =>
            group.id !== DEFAULT_SSH_GROUP_ID && Boolean(group.name?.trim()),
        )
        .map((group) => ({ ...group, name: group.name.trim() }))
        .sort((left, right) => left.name.localeCompare(right.name));
      const knownGroupIds = new Set([
        DEFAULT_SSH_GROUP_ID,
        ...groups.map((group) => group.id),
      ]);
      const records = Object.entries(values)
        .filter(([key]) => key.startsWith("profile:"))
        .map(([, value]) => value as SshProfile);
      const profiles = records
        .map((profile) => normalizeProfile(profile, knownGroupIds))
        .sort((left, right) => left.name.localeCompare(right.name));
      set({ groups, profiles, loaded: true });
      if (!subscribed) {
        subscribed = true;
        void onSharedStoreChange("ssh-profiles", () => {
          void useRemoteStore.getState().load(true);
        });
      }
      const statuses = await Promise.all(
        profiles.map((profile) =>
          remoteNative.status(profile.id).catch(
            () =>
              ({
                profileId: profile.id,
                status: "disconnected",
              }) satisfies ConnectionInfo,
          ),
        ),
      );
      set({
        statuses: Object.fromEntries(
          statuses.map((status) => [status.profileId, status]),
        ),
      });
      return profiles;
    })();
    loadInFlight = task;
    try {
      return await task;
    } finally {
      if (loadInFlight === task) loadInFlight = null;
    }
  },
  saveGroup: async (group) => {
    const normalized = { ...group, name: group.name.trim() };
    if (!normalized.name) throw new Error("SSH group name is required");
    if (!normalized.id || normalized.id === DEFAULT_SSH_GROUP_ID) {
      throw new Error("SSH group id is invalid");
    }
    if (
      get().groups.some(
        (item) =>
          item.id !== normalized.id &&
          item.name.localeCompare(normalized.name, undefined, {
            sensitivity: "base",
          }) === 0,
      )
    ) {
      throw new Error("SSH group name already exists");
    }
    const groups = [
      ...get().groups.filter((item) => item.id !== normalized.id),
      normalized,
    ].sort((left, right) => left.name.localeCompare(right.name));
    await setSharedStoreKey(
      "ssh-profiles",
      groupKey(normalized.id),
      normalized,
    );
    set({ groups });
  },
  deleteGroup: async (groupId) => {
    if (groupId === DEFAULT_SSH_GROUP_ID) return;
    const current = get();
    const movedProfiles = current.profiles
      .filter((profile) => profile.groupId === groupId)
      .map((profile) => ({
        ...profile,
        groupId: DEFAULT_SSH_GROUP_ID,
      }));
    const movedById = new Map(
      movedProfiles.map((profile) => [profile.id, profile]),
    );
    const nextProfiles = current.profiles.map((profile) =>
      profile.groupId === groupId
        ? (movedById.get(profile.id) ?? profile)
        : profile,
    );
    await mutateSharedStore("ssh-profiles", [
      ...movedProfiles.map((profile) => ({
        kind: "set" as const,
        key: profileKey(profile.id),
        value: profile,
      })),
      { kind: "delete", key: groupKey(groupId) },
    ]);
    set({
      groups: current.groups.filter((group) => group.id !== groupId),
      profiles: nextProfiles,
    });
  },
  saveProfile: async (profile) => {
    const knownGroupIds = new Set([
      DEFAULT_SSH_GROUP_ID,
      ...get().groups.map((group) => group.id),
    ]);
    const normalized = normalizeProfile(profile, knownGroupIds);
    const profiles = [
      ...get().profiles.filter((item) => item.id !== normalized.id),
      normalized,
    ].sort((a, b) => a.name.localeCompare(b.name));
    set({ profiles });
    await setSharedStoreKey(
      "ssh-profiles",
      profileKey(normalized.id),
      normalized,
    );
  },
  saveProfiles: async (incoming) => {
    const knownGroupIds = new Set([
      DEFAULT_SSH_GROUP_ID,
      ...get().groups.map((group) => group.id),
    ]);
    const byId = new Map(
      get().profiles.map((profile) => [profile.id, profile]),
    );
    for (const profile of incoming)
      byId.set(profile.id, normalizeProfile(profile, knownGroupIds));
    const profiles = [...byId.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    set({ profiles });
    await Promise.all(
      incoming.map((profile) => {
        const normalized = normalizeProfile(profile, knownGroupIds);
        return setSharedStoreKey(
          "ssh-profiles",
          profileKey(normalized.id),
          normalized,
        );
      }),
    );
  },
  deleteProfile: async (profileId) => {
    await remoteNative.disconnect(profileId).catch(() => {});
    await remoteNative.deleteSecrets(profileId).catch(() => {});
    const profiles = get().profiles.filter(
      (profile) => profile.id !== profileId,
    );
    const statuses = { ...get().statuses };
    delete statuses[profileId];
    set({ profiles, statuses });
    await deleteSharedStoreKey("ssh-profiles", profileKey(profileId));
  },
  setStatus: (info) =>
    set((state) => ({
      statuses: { ...state.statuses, [info.profileId]: info },
    })),
}));

export function newProfileId(): string {
  return `ssh-${crypto.randomUUID()}`;
}

export function newGroupId(): string {
  return `ssh-group-${crypto.randomUUID()}`;
}

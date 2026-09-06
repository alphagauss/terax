/**
 * 本文件维护跨 Workspace 进程共享的 SSH 配置与分组。
 * 连接状态只属于当前进程的 Remote Runtime，不进入共享配置 store。
 */

import {
  deleteSharedStoreKey,
  mutateSharedStore,
  onSharedStoreChange,
  readSharedStore,
  setSharedStoreKey,
} from "@/lib/sharedStore";
import { create } from "zustand";
import { remoteNative } from "@/modules/remote/native";
import { DEFAULT_SSH_GROUP_ID } from "@/modules/remote/groups";
import type { SshGroup, SshProfile, SshTunnel } from "@/modules/remote/types";

const profileKey = (id: string) => `profile:${id}`;
const groupKey = (id: string) => `group:${id}`;
let subscribed = false;
let loadInFlight: Promise<SshProfile[]> | null = null;

type RemoteState = {
  groups: SshGroup[];
  profiles: SshProfile[];
  loaded: boolean;
  /** 读取并归一化 SSH 配置；常规调用复用已完成或正在进行的加载。 */
  load: (force?: boolean) => Promise<SshProfile[]>;
  saveGroup: (group: SshGroup) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;
  saveProfile: (profile: SshProfile) => Promise<void>;
  saveProfiles: (profiles: SshProfile[]) => Promise<void>;
  deleteProfile: (profileId: string) => Promise<void>;
};

/** 归一化当前服务器配置，代理路由必须是明确支持的模式。 */
function normalizeProfile(
  { proxyMode = "direct", ...profile }: SshProfile,
  knownGroupIds: ReadonlySet<string>,
): SshProfile {
  if (!["direct", "shared", "custom"].includes(proxyMode))
    throw new Error("invalid SSH proxy mode");
  return {
    ...profile,
    groupId: knownGroupIds.has(profile.groupId)
      ? profile.groupId
      : DEFAULT_SSH_GROUP_ID,
    name: profile.name?.trim() || `${profile.username}@${profile.host}`,
    proxyMode,
    proxyUrl: proxyMode === "custom" ? profile.proxyUrl : null,
    port: normalizeInteger(profile.port, 1, 65535, 22),
    reconnectMaxAttempts: normalizeInteger(
      profile.reconnectMaxAttempts,
      1,
      20,
      2,
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
    await setSharedStoreKey(
      "ssh-profiles",
      profileKey(normalized.id),
      normalized,
    );
    set({ profiles });
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
    const runtime = await remoteNative.runtimeSnapshot().catch(() => null);
    if (
      runtime &&
      runtime.phase !== "idle" &&
      runtime.profileId === profileId
    ) {
      await remoteNative.disconnectRuntime().catch(() => {});
    }
    await remoteNative.deleteSecrets(profileId).catch(() => {});
    const profiles = get().profiles.filter(
      (profile) => profile.id !== profileId,
    );
    set({ profiles });
    await deleteSharedStoreKey("ssh-profiles", profileKey(profileId));
  },
}));

export function newProfileId(): string {
  return `ssh-${crypto.randomUUID()}`;
}

export function newGroupId(): string {
  return `ssh-group-${crypto.randomUUID()}`;
}

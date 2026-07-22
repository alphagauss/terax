import {
  deleteSharedStoreKey,
  onSharedStoreChange,
  readSharedStore,
  setSharedStoreKey,
} from "@/lib/sharedStore";
import { create } from "zustand";
import { remoteNative } from "./native";
import type { ConnectionInfo, SshProfile, SshTunnel } from "./types";

const profileKey = (id: string) => `profile:${id}`;
let subscribed = false;

type RemoteState = {
  profiles: SshProfile[];
  statuses: Record<string, ConnectionInfo>;
  loaded: boolean;
  load: () => Promise<SshProfile[]>;
  saveProfile: (profile: SshProfile) => Promise<void>;
  saveProfiles: (profiles: SshProfile[]) => Promise<void>;
  deleteProfile: (profileId: string) => Promise<void>;
  setStatus: (info: ConnectionInfo) => void;
};

function removeInlineProxyPassword(value?: string | null): string | null {
  if (!value) return null;
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/@:\s]+):[^@/]*@/i, "$1@");
}

function normalizeProfile(profile: SshProfile): SshProfile {
  return {
    ...profile,
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
  profiles: [],
  statuses: {},
  loaded: false,
  load: async () => {
    const values = await readSharedStore("ssh-profiles");
    const records = Object.entries(values)
      .filter(([key]) => key.startsWith("profile:"))
      .map(([, value]) => value as SshProfile);
    const profiles = records.map(normalizeProfile);
    set({ profiles, loaded: true });
    if (!subscribed) {
      subscribed = true;
      void onSharedStoreChange("ssh-profiles", () => {
        void useRemoteStore.getState().load();
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
  },
  saveProfile: async (profile) => {
    const normalized = normalizeProfile(profile);
    const profiles = [
      ...get().profiles.filter((item) => item.id !== normalized.id),
      normalized,
    ].sort((a, b) => a.name.localeCompare(b.name));
    set({ profiles, loaded: true });
    await setSharedStoreKey(
      "ssh-profiles",
      profileKey(normalized.id),
      normalized,
    );
  },
  saveProfiles: async (incoming) => {
    const byId = new Map(
      get().profiles.map((profile) => [profile.id, profile]),
    );
    for (const profile of incoming)
      byId.set(profile.id, normalizeProfile(profile));
    const profiles = [...byId.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    set({ profiles, loaded: true });
    await Promise.all(
      incoming.map((profile) => {
        const normalized = normalizeProfile(profile);
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
/**
 * 本文件维护跨 Workspace 进程共享的 SSH profile 状态。
 * profile 中的隧道配置通过共享存储原子保存，运行时连接状态不写入磁盘。
 */

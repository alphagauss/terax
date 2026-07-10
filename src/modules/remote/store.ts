import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { remoteNative } from "./native";
import type { ConnectionInfo, SshProfile } from "./types";

const profileStore = new LazyStore("terax-ssh-profiles.json", {
  defaults: {},
  autoSave: 300,
});
const PROFILES_KEY = "profiles";

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
  const keepalive = Number(profile.keepaliveSeconds);
  return {
    ...profile,
    proxyUrl: removeInlineProxyPassword(profile.proxyUrl),
    port: Number(profile.port) || 22,
    keepaliveSeconds:
      Number.isFinite(keepalive) && keepalive >= 0 ? keepalive : 30,
    reconnectMaxAttempts: Number(profile.reconnectMaxAttempts) || 5,
    reconnectEnabled: Boolean(profile.reconnectEnabled),
    rootPath: profile.rootPath?.trim() || "~",
  };
}

export const useRemoteStore = create<RemoteState>((set, get) => ({
  profiles: [],
  statuses: {},
  loaded: false,
  load: async () => {
    if (get().loaded) return get().profiles;
    const stored =
      (await profileStore.get<SshProfile[]>(PROFILES_KEY).catch(() => null)) ??
      [];
    const profiles = stored.map(normalizeProfile);
    if (JSON.stringify(profiles) !== JSON.stringify(stored)) {
      await profileStore.set(PROFILES_KEY, profiles);
    }
    set({ profiles, loaded: true });
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
    await profileStore.set(PROFILES_KEY, profiles);
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
    await profileStore.set(PROFILES_KEY, profiles);
  },
  deleteProfile: async (profileId) => {
    await remoteNative.disconnect(profileId).catch(() => {});
    await remoteNative.deleteSecret(profileId).catch(() => {});
    const profiles = get().profiles.filter(
      (profile) => profile.id !== profileId,
    );
    const statuses = { ...get().statuses };
    delete statuses[profileId];
    set({ profiles, statuses });
    await profileStore.set(PROFILES_KEY, profiles);
  },
  setStatus: (info) =>
    set((state) => ({
      statuses: { ...state.statuses, [info.profileId]: info },
    })),
}));

export function newProfileId(): string {
  return `ssh-${crypto.randomUUID()}`;
}

/**
 * 本文件管理内置 Provider 与自定义 Provider 实例的系统密钥链凭据。
 * 自定义凭据只按稳定实例 ID 绑定，不从名称、地址或模型名派生。
 */

import { invoke } from "@tauri-apps/api/core";
import {
  getProvider,
  KEYRING_SERVICE,
  PROVIDERS,
  type ProviderId,
  type ProviderInstance,
} from "../config";
import { PROVIDER_IDS, providerSupportsApiKey } from "../providerRegistry";

export type ProviderKeys = Record<ProviderId, string | null>;
export type ProviderInstanceKeys = Record<string, string | null>;

export const EMPTY_PROVIDER_KEYS = Object.fromEntries(
  PROVIDER_IDS.map((provider) => [provider, null]),
) as ProviderKeys;

function builtinKeyringAccount(provider: ProviderId): string | null {
  const credential = getProvider(provider).credential;
  return credential.adapter === "api-key" && credential.keyringAccount
    ? credential.keyringAccount
    : null;
}

export async function getKey(provider: ProviderId): Promise<string | null> {
  const account = builtinKeyringAccount(provider);
  if (!account) return null;
  try {
    const v = await invoke<string | null>("secrets_get", {
      service: KEYRING_SERVICE,
      account,
    });
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function setKey(provider: ProviderId, key: string): Promise<void> {
  const account = builtinKeyringAccount(provider);
  if (!account) {
    throw new Error(`${provider} does not use an API key`);
  }
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is empty");
  await invoke("secrets_set", {
    service: KEYRING_SERVICE,
    account,
    password: trimmed,
  });
}

export async function clearKey(provider: ProviderId): Promise<void> {
  const account = builtinKeyringAccount(provider);
  if (!account) return;
  try {
    await invoke("secrets_delete", {
      service: KEYRING_SERVICE,
      account,
    });
  } catch {
    // already absent, fine
  }
}

export async function getAllKeys(): Promise<ProviderKeys> {
  const out = { ...EMPTY_PROVIDER_KEYS };
  const need = PROVIDERS.flatMap((provider) => {
    const account = builtinKeyringAccount(provider.id);
    return account ? [{ id: provider.id, account }] : [];
  });
  try {
    const results = await invoke<(string | null)[]>("secrets_get_all", {
      service: KEYRING_SERVICE,
      accounts: need.map((provider) => provider.account),
    });
    need.forEach((provider, i) => {
      const v = results[i];
      out[provider.id] = v && v.length > 0 ? v : null;
    });
    return out;
  } catch {
    const entries = await Promise.all(
      need.map(
        async (provider) => [provider.id, await getKey(provider.id)] as const,
      ),
    );
    for (const [id, v] of entries) out[id] = v;
    return out;
  }
}

export function hasAnyKey(keys: ProviderKeys): boolean {
  return PROVIDERS.some(
    (provider) => providerSupportsApiKey(provider.id) && !!keys[provider.id],
  );
}

function providerInstanceKeyringAccount(providerId: string): string {
  return `provider-${providerId}-api-key`;
}

export async function getProviderInstanceKey(
  providerId: string,
): Promise<string | null> {
  try {
    const v = await invoke<string | null>("secrets_get", {
      service: KEYRING_SERVICE,
      account: providerInstanceKeyringAccount(providerId),
    });
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function setProviderInstanceKey(
  providerId: string,
  key: string,
): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is empty");
  await invoke("secrets_set", {
    service: KEYRING_SERVICE,
    account: providerInstanceKeyringAccount(providerId),
    password: trimmed,
  });
}

export async function clearProviderInstanceKey(
  providerId: string,
): Promise<void> {
  try {
    await invoke("secrets_delete", {
      service: KEYRING_SERVICE,
      account: providerInstanceKeyringAccount(providerId),
    });
  } catch {}
}

export async function getAllProviderInstanceKeys(
  providers: readonly ProviderInstance[],
): Promise<ProviderInstanceKeys> {
  if (providers.length === 0) return {};
  const out: ProviderInstanceKeys = {};
  try {
    const accounts = providers.map((provider) =>
      providerInstanceKeyringAccount(provider.id),
    );
    const results = await invoke<(string | null)[]>("secrets_get_all", {
      service: KEYRING_SERVICE,
      accounts,
    });
    providers.forEach((provider, i) => {
      const v = results[i];
      out[provider.id] = v && v.length > 0 ? v : null;
    });
  } catch {
    for (const provider of providers) {
      out[provider.id] = await getProviderInstanceKey(provider.id);
    }
  }
  return out;
}

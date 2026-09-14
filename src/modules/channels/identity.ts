/** 账号与对话使用 UUID v5；身份只取平台数据，不依赖实例 UUID、名称或绝对路径。 */
import {
  channelTargetKey,
  type ChannelTarget,
  type ChannelConnection,
} from "@/modules/channels/types";

const NAMESPACE = "6ba7b8109dad11d180b400c04fd430c8";
async function namedUuid(name: string): Promise<string> {
  const namespace = Uint8Array.from(NAMESPACE.match(/../g) ?? [], (hex) =>
    Number.parseInt(hex, 16),
  );
  const bytes = new Uint8Array([
    ...namespace,
    ...new TextEncoder().encode(name),
  ]);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)).slice(
    0,
    16,
  );
  hash[6] = (hash[6] & 15) | 80;
  hash[8] = (hash[8] & 63) | 128;
  const hex = Array.from(hash, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type Account = Pick<ChannelConnection, "kind" | "accountId">;
export function channelOwnerId(account: Account): Promise<string> {
  if (!account.accountId) throw new Error("Channel account is unavailable");
  return namedUuid(
    JSON.stringify(["terax.channel.account", account.kind, account.accountId]),
  );
}

export async function channelSessionId(
  account: Account,
  target: ChannelTarget,
): Promise<string> {
  return namedUuid(
    JSON.stringify([
      "terax.channel.session",
      await channelOwnerId(account),
      channelTargetKey(target),
    ]),
  );
}

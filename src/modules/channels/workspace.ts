/** 平台账号决定 Channel cwd，目录键不暴露原始账号或连接 UUID。 */
import { getNativeHost } from "@/lib/nativeHost";
import type { ChannelConnection } from "@/modules/channels/types";

const ACCOUNT_KEY_HASH_BYTES = 8;

/** 将摘要字节转为跨平台文件名安全的无填充 Base64URL 文本。 */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 基于平台与账号生成短而稳定的目录键，避免原始账号进入路径。 */
export async function channelAccountKey(
  kind: string,
  accountId: string,
): Promise<string> {
  if (!/^[a-z0-9-]{1,32}$/.test(kind) || !accountId || accountId.length > 256)
    throw new Error("Invalid channel account");
  const source = new TextEncoder().encode(`${kind}\0${accountId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  return `${kind}-${base64Url(digest.slice(0, ACCOUNT_KEY_HASH_BYTES))}`;
}

export async function prepareChannelWorkspace(
  connection: Pick<ChannelConnection, "kind" | "accountId">,
): Promise<string> {
  if (!connection.accountId) throw new Error("Channel account is unavailable");
  const key = await channelAccountKey(connection.kind, connection.accountId);
  return (await getNativeHost()).invoke<string>(
    "workspace_prepare_default_root",
    { appSubdir: `channels/${key}` },
  );
}

/** 保留平台文件名，仅替换跨平台非法字符；重名由原生原子发布时裁决。 */
export function channelAttachmentPath(name: string): string {
  const leaf = name.split(/[\\/]/).pop() ?? "attachment";
  const clean =
    leaf
      .replace(/[\x00-\x1f\x7f-\x9f<>:"\\|?*]/g, "_")
      .replace(/[. ]+$/g, "") || "attachment";
  const reserved = /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(
    clean,
  );
  return `attachments/${reserved ? "_" : ""}${clean}`;
}

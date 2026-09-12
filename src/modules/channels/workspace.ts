/** 平台账号决定 Channel cwd，连接 UUID 只决定运行实例，不参与文件目录身份。 */
import { getNativeHost } from "@/lib/nativeHost";
import type { ChannelConnection } from "@/modules/channels/types";

export function channelAccountKey(kind: string, accountId: string): string {
  if (!/^[a-z0-9-]{1,32}$/.test(kind) || !accountId || accountId.length > 256)
    throw new Error("Invalid channel account");
  // 保留账号中可读的 @；转义路径分隔符、星号及结尾的点，避免跨平台路径歧义。
  const name = encodeURIComponent(accountId)
    .replace(/%40/gi, "@")
    .replace(/\*/g, "%2A")
    .replace(/\.+$/, (dots) => "%2E".repeat(dots.length));
  return `${kind}-${name}`;
}

export async function prepareChannelWorkspace(
  connection: Pick<ChannelConnection, "kind" | "accountId">,
): Promise<string> {
  if (!connection.accountId) throw new Error("Channel account is unavailable");
  const key = channelAccountKey(connection.kind, connection.accountId);
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

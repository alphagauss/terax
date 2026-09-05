/**
 * 本文件通过既有白名单存储保存连接配置与有界协议检查点。
 * 会话正文仍归 sessions，凭据仍归系统密钥存储。
 */

import {
  deleteSharedStoreKey,
  readSharedStore,
  setSharedStoreKey,
} from "@/lib/sharedStore";
import {
  type ChannelCheckpoint,
  type ChannelConnection,
  ChannelError,
  checkpointSchema,
  connectionSchema,
} from "@/modules/channels/types";

export const MAX_CONNECTIONS = 8;

/** 严格读取当前配置，拒绝重复会话绑定和损坏记录。 */
export async function loadConnections(): Promise<ChannelConnection[]> {
  const values = await readSharedStore("channels");
  const ids = new Set<string>();
  const connections = Object.entries(values).map(([id, value]) => {
    const result = connectionSchema.safeParse(value);
    if (
      !result.success ||
      result.data.id !== id ||
      ids.has(result.data.sessionId)
    )
      throw new ChannelError("storage");
    ids.add(result.data.sessionId);
    return result.data;
  });
  if (connections.length > MAX_CONNECTIONS) throw new ChannelError("storage");
  return connections;
}

/** 保存一个连接，调用方由 Local 主窗口串行管理配置变更。 */
export function saveConnection(connection: ChannelConnection): Promise<void> {
  return setSharedStoreKey(
    "channels",
    connection.id,
    connectionSchema.parse(connection),
  );
}

/** 删除配置引用，保留已经生成的聊天历史。 */
export function removeConnection(id: string): Promise<void> {
  return deleteSharedStoreKey("channels", id);
}

/** 读取单连接检查点；没有文件表示尚未开始接收。 */
export async function loadCheckpoint(id: string): Promise<ChannelCheckpoint> {
  const value = (await readSharedStore(`channels-state:${id}`)).checkpoint;
  if (value === undefined)
    return { cursor: "", cursorScope: "", recentIds: [], pendingIds: [] };
  const parsed = checkpointSchema.safeParse(value);
  if (!parsed.success) throw new ChannelError("storage");
  return parsed.data;
}

/** 检查点只记录消息身份，不把平台回复令牌或聊天正文写入状态文件。 */
export function saveCheckpoint(
  id: string,
  checkpoint: ChannelCheckpoint,
): Promise<void> {
  return setSharedStoreKey(
    `channels-state:${id}`,
    "checkpoint",
    checkpointSchema.parse(checkpoint),
  );
}

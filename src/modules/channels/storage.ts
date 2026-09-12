/**
 * 连接配置使用共享存储；检查点由唯一连接宿主经普通文件接口原子保存。
 * 检查点的串行写入和退出等待归连接运行时，会话正文与凭据分别归 sessions 和秘密存储。
 */

import { channelModelUsageId } from "@/modules/ai/lib/modelUsage";
import { deleteModelUsage } from "@/modules/settings/store";
import {
  deleteSharedStoreKey,
  readSharedStore,
  setSharedStoreKey,
} from "@/lib/sharedStore";
import { invokeNative } from "@/lib/nativeHost";
import {
  type ChannelCheckpoint,
  type ChannelConnection,
  ChannelError,
  checkpointSchema,
  connectionSchema,
} from "@/modules/channels/types";

/** 严格读取当前配置，拒绝重复会话绑定和损坏记录。 */
export async function loadConnections(): Promise<ChannelConnection[]> {
  const values = await readSharedStore("channels");
  const ids = new Set<string>();
  const accounts = new Set<string>();
  const connections = Object.entries(values).map(([id, value]) => {
    const result = connectionSchema.safeParse(value);
    if (
      !result.success ||
      result.data.id !== id ||
      ids.has(result.data.sessionId)
    )
      throw new ChannelError("configuration");
    ids.add(result.data.sessionId);
    if (result.data.accountId) {
      const account = JSON.stringify([result.data.kind, result.data.accountId]);
      if (accounts.has(account)) throw new ChannelError("configuration");
      accounts.add(account);
    }
    return result.data;
  });
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

/** 先清理协议状态和网络设置，最后删除配置引用；中途失败时保留可重试的连接。 */
export async function removeConnection(id: string): Promise<void> {
  const path = await checkpointPath(id);
  if (await checkpointExists(path))
    await invokeNative("fs_delete", { path, workspace: { kind: "local" } });
  await deleteSharedStoreKey("settings", `network.channel:${id}`);
  await deleteModelUsage(channelModelUsageId(id));
  await deleteSharedStoreKey("channels", id);
}

/** 读取单连接检查点；没有文件表示尚未开始接收。 */
export async function loadCheckpoint(id: string): Promise<ChannelCheckpoint> {
  try {
    const path = await checkpointPath(id);
    if (!(await checkpointExists(path)))
      return { cursor: "", cursorScope: "", recentIds: [], pendingIds: [] };
    const result = await invokeNative<{ kind: string; content?: string }>(
      "fs_read_file",
      { path, workspace: { kind: "local" } },
    );
    if (result.kind !== "text" || typeof result.content !== "string")
      throw new ChannelError("storage");
    return checkpointSchema.parse(JSON.parse(result.content));
  } catch {
    throw new ChannelError("storage");
  }
}

/** 检查点只记录消息身份，不把平台回复令牌或聊天正文写入状态文件。 */
export async function saveCheckpoint(
  id: string,
  checkpoint: ChannelCheckpoint,
): Promise<void> {
  try {
    const path = await checkpointPath(id);
    await invokeNative("fs_write_file", {
      path,
      content: JSON.stringify(checkpointSchema.parse(checkpoint)),
      workspace: { kind: "local" },
    });
  } catch {
    throw new ChannelError("storage");
  }
}

/** 路径由 TS 业务定义，原生只准备应用数据目录，UUID 校验阻止路径注入。 */
async function checkpointPath(id: string): Promise<string> {
  const key = connectionSchema.shape.id.parse(id);
  const root = await invokeNative<string>("workspace_prepare_default_root", {
    appSubdir: "channels/state",
  });
  return `${root}/${key}.json`;
}

async function checkpointExists(path: string): Promise<boolean> {
  const stat = await invokeNative<{ kind: string } | null>("fs_stat", {
    path,
    workspace: { kind: "local" },
    missingOk: true,
  });
  if (stat === null) return false;
  if (stat.kind !== "file") throw new ChannelError("storage");
  return true;
}

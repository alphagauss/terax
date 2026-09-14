/**
 * 连接配置使用共享存储；检查点由唯一连接宿主经普通文件接口原子保存。
 * 检查点的串行写入和退出等待归连接运行时，会话正文与凭据分别归 sessions 和秘密存储。
 */

import { prepareChannelWorkspace } from "@/modules/channels/workspace";
import { channelSessionId } from "@/modules/channels/identity";
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
  protocolCheckpointSchema,
  connectionSchema,
} from "@/modules/channels/types";

/** 严格读取当前配置，拒绝重复账号和损坏记录。 */
export async function loadConnections(): Promise<ChannelConnection[]> {
  const values = await readSharedStore("channels");
  const accounts = new Set<string>();
  const connections = Object.entries(values).map(([id, value]) => {
    const result = connectionSchema.safeParse(value);
    if (!result.success || result.data.id !== id)
      throw new ChannelError("configuration");
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

/** 协议状态归实例，可读对话索引归账号；移除实例不删除索引。 */
export async function loadCheckpoint(
  connection: ChannelConnection,
): Promise<ChannelCheckpoint> {
  try {
    const protocol = await readJson(await checkpointPath(connection.id));
    const index = connection.accountId
      ? await readJson(
          `${await prepareChannelWorkspace(connection)}/conversations.json`,
        )
      : undefined;
    const conversations = index === undefined ? [] : index;
    const checkpoint = checkpointSchema.parse({
      ...protocolCheckpointSchema.parse(
        protocol === undefined
          ? { cursor: "", cursorScope: "", recentIds: [], pendingIds: [] }
          : protocol,
      ),
      conversations,
    });
    for (const item of checkpoint.conversations) {
      if (item.sessionId !== (await channelSessionId(connection, item.target)))
        throw new ChannelError("storage");
    }
    return checkpoint;
  } catch {
    throw new ChannelError("storage");
  }
}

/** 索引先落盘，随后推进协议身份；失败不执行 Agent，重试只补写事实。 */
export async function saveCheckpoint(
  connection: ChannelConnection,
  checkpoint: ChannelCheckpoint,
): Promise<void> {
  try {
    connectionSchema.parse(connection);
    const { conversations, ...protocol } = checkpointSchema.parse(checkpoint);
    await writeJson(
      `${await prepareChannelWorkspace(connection)}/conversations.json`,
      conversations,
    );
    await writeJson(await checkpointPath(connection.id), protocol);
  } catch {
    throw new ChannelError("storage");
  }
}

async function readJson(path: string): Promise<unknown | undefined> {
  if (!(await checkpointExists(path))) return undefined;
  const result = await invokeNative<{ kind: string; content?: string }>(
    "fs_read_file",
    { path, workspace: { kind: "local" } },
  );
  if (result.kind !== "text" || typeof result.content !== "string")
    throw new ChannelError("storage");
  return JSON.parse(result.content);
}
async function writeJson(path: string, content: unknown): Promise<void> {
  await invokeNative("fs_write_file", {
    path,
    content: JSON.stringify(content),
    workspace: { kind: "local" },
  });
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

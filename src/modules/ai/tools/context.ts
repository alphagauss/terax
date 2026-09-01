/**
 * 本文件定义 AI 工具可访问的固定会话目录、终端能力和权限来源。
 * 主 Agent 可读取实时权限，Subagent 通过同一接口使用启动时快照。
 */

export type ToolContext = {
  /** 当前会话固定 cwd，用于解析所有相对路径。 */
  getCwd: () => string;
  /** 读取活动非隐私终端的尾部缓冲区，没有可读终端时返回 null。 */
  getTerminalContext: () => string | null;
  /** 活动标签是否为隐私终端。 */
  isActiveTerminalPrivate: () => boolean;
  /** 当前聊天会话 ID，供待办事项等按会话持久化的工具使用。 */
  getSessionId: () => string;
  /** 读取本次工具运行应遵循的权限模式；Subagent 使用启动时冻结的值。 */
  getPermissionMode: () => "ask" | "full-access";
};

export function resolvePath(rawPath: string, cwd: string): string {
  if (rawPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rawPath))
    return rawPath;
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  return cwd.endsWith(sep) ? `${cwd}${rawPath}` : `${cwd}${sep}${rawPath}`;
}

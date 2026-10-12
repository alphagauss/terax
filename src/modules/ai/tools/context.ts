/**
 * 本文件定义 AI 工具可访问的固定会话目录、终端能力和权限来源。
 * 主 Agent 可读取实时权限，Subagent 通过同一接口使用启动时快照。
 */

export type ToolContext = {
  /** 与本轮系统提示共用的解释器快照，Subagent 原样继承。 */
  shells?: readonly import("@/modules/ai/lib/native").ShellIdentity[];
  /** 只由 Channel 主运行提供，不向 Subagent 传播发送能力。 */
  getMessageSender?: () =>
    | import("@/modules/channels/types").ChannelMessageSender
    | undefined;
  /** 当前会话固定 cwd，用于解析所有相对路径。 */
  getCwd: () => string;
  /** 按指定行数读取活动非隐私终端的尾部缓冲区，没有可读终端时返回 null。 */
  getTerminalContext: (maxLines: number) => string | null;
  /** 活动标签是否为隐私终端。 */
  isActiveTerminalPrivate: () => boolean;
  /** 当前聊天会话 ID，供待办事项等按会话持久化的工具使用。 */
  getSessionId: () => string;
  /** 读取本次工具运行应遵循的权限模式；Subagent 使用启动时冻结的值。 */
  getPermissionMode: () => "ask" | "full-access";
  /** 当前 runner 是否能将需要提权的调用交给 UI 审批。 */
  supportsApprovals: boolean;
  /** 内置 Subagent 的展示归属，与原生会话授权身份分开。 */
  fileEditTaskId?: string;
  onFileEditInput?: (
    toolCallId: string,
    toolName: string,
    input: unknown,
  ) => void;
};

export function resolvePath(rawPath: string, cwd: string): string {
  if (
    rawPath.startsWith("/") ||
    rawPath.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(rawPath)
  )
    return rawPath;
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  return cwd.endsWith(sep) ? `${cwd}${rawPath}` : `${cwd}${sep}${rawPath}`;
}

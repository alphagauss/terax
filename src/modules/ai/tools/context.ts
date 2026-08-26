/**
 * 本文件定义 AI 工具可访问的固定会话目录与实时终端能力。
 * 路径基准来自会话，终端读取通过受控回调执行。
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
};

export function resolvePath(rawPath: string, cwd: string): string {
  if (rawPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rawPath))
    return rawPath;
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  return cwd.endsWith(sep) ? `${cwd}${rawPath}` : `${cwd}${sep}${rawPath}`;
}

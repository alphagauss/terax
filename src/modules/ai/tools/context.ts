/**
 * 本文件定义 AI 工具可访问的固定会话目录与实时 Workbench 能力。
 * 路径基准来自会话，终端和页面操作通过受控回调执行。
 */

export type ToolContext = {
  /** 当前会话固定 cwd，用于解析所有相对路径。 */
  getCwd: () => string;
  /** Last N lines of the active terminal buffer (or null if not a terminal tab). */
  getTerminalContext: () => string | null;
  isActiveTerminalPrivate: () => boolean;
  /**
   * 向活动终端输入文本但不执行。
   * 没有可写入的活动终端标签时返回 false。
   */
  injectIntoActivePty: (text: string) => boolean;
  /** Open a new preview tab (in-app iframe) at the given URL. */
  openWebPreview: (url: string) => boolean;
  /** 在新终端标签中启动绑定到当前会话的 Claude Code Agent。 */
  spawnAgent: (prompt: string) => Promise<number | null>;
  /** 读取托管 Agent 所在终端的滚动缓冲区尾部。 */
  readAgentOutput: (tabId: number) => string | null;
  readCache: Map<string, { size: number; hash: number }>;
  /** 当前聊天会话 ID，供待办事项等按会话持久化的工具使用。 */
  getSessionId: () => string | null;
};

export function resolvePath(rawPath: string, cwd: string): string {
  if (rawPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rawPath))
    return rawPath;
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  return cwd.endsWith(sep) ? `${cwd}${rawPath}` : `${cwd}${sep}${rawPath}`;
}

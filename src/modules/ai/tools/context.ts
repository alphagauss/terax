/**
 * 本文件定义 AI 工具可访问的实时 Workbench 能力。
 * 工具只能通过受控回调操作终端和页面，不直接持有 React 或原生运行时状态。
 */

export type ToolContext = {
  /** Active terminal tab cwd, used to resolve relative paths. Null = home. */
  getCwd: () => string | null;
  /** Workspace root (explorer root). Used by tools that operate over the project. */
  getWorkspaceRoot: () => string | null;
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

export function resolvePath(rawPath: string, cwd: string | null): string {
  if (rawPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rawPath))
    return rawPath;
  if (!cwd)
    throw new Error(
      `cannot resolve relative path "${rawPath}": no active terminal cwd. Pass an absolute path.`,
    );
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  return cwd.endsWith(sep) ? `${cwd}${rawPath}` : `${cwd}${sep}${rawPath}`;
}

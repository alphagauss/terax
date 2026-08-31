/**
 * 本文件负责读取会话工作目录根部的 AGENTS.md。
 * 项目指令完整返回，不执行静默截断，也不兼容其他专用文件名。
 */

import { native } from "./native";

/**
 * 读取会话工作目录根部的项目指令。
 *
 * 调用方在 Chat runtime 内缓存最终系统提示词，因此这里始终读取当前文件。
 */
export async function readAgentsMd(cwd: string): Promise<string | null> {
  const path = `${cwd.replace(/\/$/, "")}/AGENTS.md`;
  try {
    const result = await native.readFile(path);
    return result.kind === "text" ? result.content : null;
  } catch {
    return null;
  }
}

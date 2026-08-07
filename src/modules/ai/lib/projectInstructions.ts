/**
 * 本文件负责读取并缓存会话工作目录根部的 AGENTS.md。
 * 项目指令完整返回，不执行静默截断，也不兼容其他专用文件名。
 */

import { native } from "./native";

type InstructionsCacheEntry = { content: string | null; mtime: number };
const instructionsCache = new Map<string, InstructionsCacheEntry>();

/**
 * 读取会话工作目录根部的项目指令。
 *
 * 读取结果会短暂缓存，避免每轮对话都触发文件系统 IPC。
 */
export async function readAgentsMd(cwd: string): Promise<string | null> {
  const path = `${cwd.replace(/\/$/, "")}/AGENTS.md`;
  const cached = instructionsCache.get(cwd);
  if (cached && Date.now() - cached.mtime < 30_000) return cached.content;
  try {
    const result = await native.readFile(path);
    if (result.kind !== "text") {
      instructionsCache.set(cwd, {
        content: null,
        mtime: Date.now(),
      });
      return null;
    }
    instructionsCache.set(cwd, {
      content: result.content,
      mtime: Date.now(),
    });
    return result.content;
  } catch {
    instructionsCache.set(cwd, {
      content: null,
      mtime: Date.now(),
    });
    return null;
  }
}

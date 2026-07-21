/**
 * 本文件负责读取并缓存工作区根目录的 AGENTS.md。
 * 项目指令完整返回，不执行静默截断，也不兼容其他专用文件名。
 */

import { native } from "./native";

type InstructionsCacheEntry = { content: string | null; mtime: number };
const instructionsCache = new Map<string, InstructionsCacheEntry>();

/**
 * 读取工作区根目录中的项目指令。
 *
 * 读取结果会短暂缓存，避免每轮对话都触发文件系统 IPC。
 */
export async function readAgentsMd(
  workspaceRoot: string | null,
): Promise<string | null> {
  if (!workspaceRoot) return null;
  const path = `${workspaceRoot.replace(/\/$/, "")}/AGENTS.md`;
  const cached = instructionsCache.get(workspaceRoot);
  if (cached && Date.now() - cached.mtime < 30_000) return cached.content;
  try {
    const result = await native.readFile(path);
    if (result.kind !== "text") {
      instructionsCache.set(workspaceRoot, {
        content: null,
        mtime: Date.now(),
      });
      return null;
    }
    instructionsCache.set(workspaceRoot, {
      content: result.content,
      mtime: Date.now(),
    });
    return result.content;
  } catch {
    instructionsCache.set(workspaceRoot, {
      content: null,
      mtime: Date.now(),
    });
    return null;
  }
}

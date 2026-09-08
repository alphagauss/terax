/**
 * 按智能体配置顺序加载会话工作区指令文件。
 * 缺失文件静默跳过，其他读取失败中止本轮，不缓存或截断正文。
 */
import { native, type ReadResult } from "./native";
import { parseWorkspaceFiles } from "./agentDefinition";
import { resolvePath } from "@/modules/ai/tools/context";

export type WorkspaceInstruction = { path: string; content: string };

/** 只在实际运行中读取，设置页不推断 cwd 或访问项目文件。 */
export async function readWorkspaceInstructions(
  cwd: string,
  files: readonly string[],
): Promise<WorkspaceInstruction[]> {
  const instructions: WorkspaceInstruction[] = [];
  for (const path of parseWorkspaceFiles(files.join(","))) {
    const absolutePath = resolvePath(path, cwd);
    let result: ReadResult;
    try {
      result = await native.readFile(absolutePath);
    } catch (error) {
      // 原生版本查询跨平台区分文件缺失与权限、连接等错误，不解析本地化错误字符串。
      if ((await native.fileVersion(absolutePath)) === null) continue;
      throw error;
    }
    if (result.kind !== "text")
      throw new Error(
        `Workspace instruction file is not readable text: ${path}`,
      );
    instructions.push({ path, content: result.content });
  }
  return instructions;
}

/**
 * 本文件为每次模型请求提供 SDK 工具审批策略。
 * 权限模式在调用时读取，工具只负责执行，原生层仍拥有最终授权边界。
 */
import type { ToolApprovalConfiguration } from "ai";
import type { ToolContext } from "./context";
import type { ChatTools } from "./tools";
import {
  fileOperationNeedsApproval,
  pathNeedsApproval,
  shellNeedsApproval,
} from "./authorization";

/** 主 Agent 使用交互审批；无审批界面的宿主继续由原生限制拒绝越界操作。 */
export function buildToolApproval(ctx: ToolContext) {
  const status = (required: boolean) =>
    ctx.supportsApprovals && ctx.getPermissionMode() === "ask" && required
      ? "user-approval"
      : "not-applicable";
  return {
    read_file: ({ path }) => status(pathNeedsApproval(path, ctx.getCwd())),
    write_file: ({ path }) => status(pathNeedsApproval(path, ctx.getCwd())),
    find_files: ({ path }) =>
      status(pathNeedsApproval(path ?? ".", ctx.getCwd())),
    grep: ({ path }) => status(pathNeedsApproval(path ?? ".", ctx.getCwd())),
    apply_patch: ({ edits }) =>
      status(edits.some(({ path }) => pathNeedsApproval(path, ctx.getCwd()))),
    file_operation: (input) =>
      status(fileOperationNeedsApproval(input, ctx.getCwd())),
    shell_exec: (input) =>
      status(shellNeedsApproval(input.command, input.cwd, ctx.getCwd())),
    shell_process: (input) => status(input.action === "write"),
  } satisfies ToolApprovalConfiguration<ChatTools, unknown>;
}

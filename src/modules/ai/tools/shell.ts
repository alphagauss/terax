/**
 * 本文件定义 AI 的统一 Shell 启动、进程控制和进程发现工具。
 * 所有命令进入原生受管进程表，Local、WSL 与 SSH 共享同一交互和输出契约。
 */

import { tool } from "ai";
import { z } from "zod";
import {
  native,
  type ShellProcessInfo,
  type ShellProcessResponse,
} from "../lib/native";
import { redactSensitive } from "../lib/redact";
import { accessModeForCall, shellNeedsApproval } from "./authorization";
import { resolvePath, type ToolContext } from "./context";

const DEFAULT_TIMEOUT_SECS = 300;
const DEFAULT_YIELD_MS = 10_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;

const outputOptions = {
  since_offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Byte offset for returned output and wait_for matching; defaults to 0. Reuse next_offset for only subsequent output. Use 0 to also search earlier output still retained in the buffer.",
    ),
  max_output_bytes: z
    .number()
    .int()
    .min(1024)
    .max(256 * 1024)
    .optional(),
};

const waitOptions = {
  yield_time_ms: z
    .number()
    .int()
    .min(0)
    .max(30_000)
    .optional()
    .describe(
      "Maximum time to wait before returning a poll or write response when wait_for is omitted. Defaults to 1000. This does not change the process timeout.",
    ),
  wait_for: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      "Literal text to match in stdout or stderr at or after since_offset, including already-buffered output. An option for action=poll or action=write, not an action itself. Earlier or evicted output is not searched.",
    ),
  wait_timeout_ms: z
    .number()
    .int()
    .min(0)
    .max(120_000)
    .optional()
    .describe(
      "Maximum time to wait for wait_for. Only valid when wait_for is set and defaults to 10000. This does not change the process timeout.",
    ),
};

const processInputSchema = z
  .object({
    process_id: z.string().uuid(),
    action: z.enum(["poll", "write", "close_stdin", "terminate"]),
    input: z
      .string()
      .max(256 * 1024)
      .optional()
      .describe(
        "Exact stdin text. Required for action=write; omit for other actions.",
      ),
    close_stdin: z
      .boolean()
      .optional()
      .describe(
        "Send EOF after writing. true is only valid for action=write; defaults to false.",
      ),
    ...outputOptions,
    ...waitOptions,
  })
  .superRefine((input, ctx) => {
    if (
      input.wait_for !== undefined &&
      input.action !== "poll" &&
      input.action !== "write"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["wait_for"],
        message: "wait_for is only valid for poll or write",
      });
    }
    if (input.action === "write" && input.input === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["input"],
        message: "input is required when action is write",
      });
    }
    if (input.action !== "write" && input.input !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["input"],
        message: "input is only valid when action is write",
      });
    }
    if (input.action !== "write" && input.close_stdin === true) {
      ctx.addIssue({
        code: "custom",
        path: ["close_stdin"],
        message: "close_stdin=true is only valid when action is write",
      });
    }
    if (input.wait_for === undefined && input.wait_timeout_ms !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["wait_timeout_ms"],
        message: "wait_timeout_ms requires wait_for",
      });
    }
    if (input.wait_for !== undefined && input.yield_time_ms !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["yield_time_ms"],
        message: "use wait_timeout_ms instead of yield_time_ms with wait_for",
      });
    }
  });

/** 创建统一 Shell 工具，并在每次有副作用的调用前读取最新权限模式。 */
export function buildShellTools(ctx: ToolContext) {
  return {
    shell_exec: tool({
      description:
        "Start a managed non-TTY shell process for tests, builds, package commands, dev servers, watchers, and other command execution. Workspace-local commands run automatically; outside paths, network access, and commands that cannot be classified safely require approval unless full access is enabled. The call waits briefly and returns a process_id whether the command exits or keeps running. The process timeout starts at launch and continues after status=running is returned; pass timeout_secs=null for an intentionally long-running server or watcher. Never start full-screen TTY programs such as vim, less, or top.",
      inputSchema: z.object({
        command: z
          .string()
          .min(1)
          .max(256 * 1024),
        cwd: z
          .string()
          .max(32 * 1024)
          .nullable()
          .optional()
          .describe(
            "Explicit cwd applies only to this process; relative values resolve from the session's fixed working directory. If omitted or null, uses the chat cwd, initially the session directory. Only commands without explicit cwd that finish before shell_exec returns update the chat cwd.",
          ),
        timeout_secs: z
          .number()
          .int()
          .min(1)
          .max(3600)
          .nullable()
          .optional()
          .describe(
            "Process lifetime limit in seconds, counted from launch and still active after status=running is returned. Defaults to 300; use null to disable the automatic timeout for an intentionally long-running process.",
          ),
        yield_time_ms: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe(
            "Maximum time this call waits for the initial process result. Defaults to 10000. This does not change or disable the process timeout.",
          ),
        max_output_bytes: z
          .number()
          .int()
          .min(1024)
          .max(256 * 1024)
          .optional(),
        shell: z
          .enum(["default", "bash", "sh", "zsh", "powershell", "cmd"])
          .optional(),
        login: z.boolean().optional(),
      }),
      execute: async (input) => {
        const approvalRequired =
          ctx.supportsApprovals &&
          ctx.getPermissionMode() === "ask" &&
          shellNeedsApproval(input.command, input.cwd, ctx.getCwd());
        const sessionId = ctx.getSessionId();
        if (!sessionId) return { error: "no active chat session" };
        try {
          const response = await native.shellExec({
            ownerSessionId: sessionId,
            command: input.command,
            initialCwd: ctx.getCwd(),
            cwd: input.cwd ? resolvePath(input.cwd, ctx.getCwd()) : null,
            permissionMode: accessModeForCall(
              ctx.getPermissionMode(),
              approvalRequired,
            ),
            timeoutSecs:
              input.timeout_secs === null
                ? 0
                : (input.timeout_secs ?? DEFAULT_TIMEOUT_SECS),
            yieldTimeMs: input.yield_time_ms ?? DEFAULT_YIELD_MS,
            maxOutputBytes: input.max_output_bytes ?? DEFAULT_OUTPUT_BYTES,
            shell: input.shell ?? "default",
            login: input.login ?? false,
          });
          return redactProcessResponse(response);
        } catch (error) {
          return { error: String(error) };
        }
      },
    }),

    shell_process: tool({
      description:
        "Control a process returned by shell_exec in this chat. Poll incremental stdout/stderr, wait for literal output, write exact stdin bytes, close stdin to send EOF, or terminate the complete process tree. Reuse next_offset as since_offset to avoid duplicate output. If truncated is true, continue reading from next_offset; dropped_bytes greater than zero means older output was evicted and cannot be recovered. Polling and waiting do not extend the process timeout.",
      inputSchema: processInputSchema,
      execute: async (input) => {
        const sessionId = ctx.getSessionId();
        if (!sessionId) return { error: "no active chat session" };
        try {
          const response = await native.shellProcess({
            ownerSessionId: sessionId,
            processId: input.process_id,
            action: input.action,
            input: input.action === "write" ? input.input : null,
            closeStdin:
              input.action === "write" ? (input.close_stdin ?? false) : false,
            sinceOffset: input.since_offset ?? null,
            yieldTimeMs:
              "yield_time_ms" in input ? (input.yield_time_ms ?? null) : null,
            waitFor: "wait_for" in input ? (input.wait_for ?? null) : null,
            waitTimeoutMs:
              "wait_timeout_ms" in input
                ? (input.wait_timeout_ms ?? null)
                : null,
            maxOutputBytes: input.max_output_bytes ?? null,
          });
          return redactProcessResponse(response);
        } catch (error) {
          return { error: String(error) };
        }
      },
    }),

    shell_list: tool({
      description:
        "List managed shell processes owned by this chat in the current Workspace. Call this before starting a dev server or watcher so an existing process can be reused instead of duplicated. Auto-executes.",
      inputSchema: z.object({
        include_exited: z
          .boolean()
          .optional()
          .describe(
            "Include recently finished, terminated, and timed-out processes. Defaults to false; enable it to diagnose a process that disappeared from the running list.",
          ),
      }),
      execute: async ({ include_exited }) => {
        const sessionId = ctx.getSessionId();
        if (!sessionId) return { error: "no active chat session" };
        try {
          return {
            processes: (
              await native.shellList(sessionId, include_exited ?? false)
            ).map(redactProcessInfo),
          };
        } catch (error) {
          return { error: String(error) };
        }
      },
    }),
  } as const;
}

function redactProcessResponse(
  response: ShellProcessResponse,
): ShellProcessResponse {
  return {
    ...response,
    stdout: redactSensitive(response.stdout),
    stderr: redactSensitive(response.stderr),
  };
}

function redactProcessInfo(process: ShellProcessInfo): ShellProcessInfo {
  return {
    ...process,
    command: redactSensitive(process.command),
  };
}

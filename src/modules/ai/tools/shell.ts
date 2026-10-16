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

const POSIX_INDEPENDENT_SERVICE =
  "For an independent noninteractive service that must outlive Terax, use nohup with all three standard streams redirected, e.g. nohup ./server </dev/null >server.log 2>&1 & echo $!.";

/** 仅选择实际执行环境的说明，避免把宿主平台或其他连接方式写入模型工具定义。 */
const SHELL_ENVIRONMENT_DESCRIPTIONS = {
  Windows:
    "This tool runs on local Windows. Start-Process and Start-Job inside this tool do not escape its Job Object. For independent launch, use the system WMI/CIM Win32_Process.Create method with absolute executable paths, set CurrentDirectory and Win32_ProcessStartup.ShowWindow=0, redirect stdin and both outputs in the launched command, and check ReturnValue and ProcessId. The independent process does not inherit this tool's environment variables.",
  Linux: `This tool runs on local Linux. ${POSIX_INDEPENDENT_SERVICE}`,
  macOS: `This tool runs on local macOS. ${POSIX_INDEPENDENT_SERVICE}`,
  wsl: `This tool runs inside the current WSL distribution. Service commands, paths, and logs belong to that distribution. ${POSIX_INDEPENDENT_SERVICE}`,
  ssh: `This tool runs on the current Linux SSH host. Commands, paths, and logs are remote. SSH connection loss can interrupt managed processes; neither survival nor successful remote cleanup is guaranteed after a disconnect. ${POSIX_INDEPENDENT_SERVICE}`,
  Unknown: "",
};

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
  const environment = ctx.environment;
  const shells = environment?.shells ?? [];
  const environmentDescription = environment
    ? SHELL_ENVIRONMENT_DESCRIPTIONS[
        environment.backend === "local"
          ? environment.platform
          : environment.backend
      ]
    : "";
  const hasPowerShell = shells.some(
    ({ kind }) => kind === "pwsh" || kind === "powershell",
  );
  return {
    shell_exec: tool({
      description:
        "Start a managed non-TTY shell process for tests, builds, package commands, dev servers, watchers, and other command execution. Recognized commands within the session working directory run automatically; outside paths, network access, and commands that cannot be classified safely require approval unless full access is enabled. The call waits briefly and returns a process_id whether the command exits or keeps running. The process timeout starts at launch and continues after status=running is returned; pass timeout_secs=null for an intentionally long-running server or watcher. A running response confirms launch, not success. If the task depends on the result, poll until exit and check the exit status before claiming completion. Normal agent or subagent completion does not stop managed background processes, but cancellation of their execution, explicit termination, timeout, chat deletion, and application exit can stop them. " +
        environmentDescription +
        " Wait for the launcher to exit and separately verify the service PID and readiness; launcher success is not service success. Independently launched services are not registered in shell_list, cannot be controlled by shell_process, and are not covered by this tool's timeout or cleanup after the launcher exits; inspect their log files and stop them explicitly by their verified OS identity. Before finishing, terminate temporary processes you no longer need; report the managed process_id or independent OS PID, purpose, observed status, access details, log locations, and how to stop any intentionally retained services. Subagents must include this handoff in their result. Only stop processes you started or were explicitly asked to manage. Never start full-screen TTY programs such as vim, less, or top.",
      inputSchema: z.object({
        command: z
          .string()
          .min(1)
          .max(256 * 1024)
          .describe(
            "Shell source interpreted directly by the selected shell. Use its syntax and invoke scripts directly. When nesting shells, protect inner variables from expansion by the outer shell." +
              (hasPowerShell
                ? " For PowerShell scripts, use & './script.ps1' in the selected interpreter."
                : ""),
          ),
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
          .enum(["default", ...shells.map(({ kind }) => kind)])
          .optional()
          .describe(
            'Omitted or "default" uses the default interpreter listed in SESSION ENVIRONMENT. Explicit selectors use their listed executable. Use the selected interpreter’s syntax. Unavailable selections fail; execution failures never switch interpreters.',
          ),
        login: z
          .boolean()
          .optional()
          .describe(
            "Defaults to false. Requests login mode for the selected interpreter; unsupported selections fail.",
          ),
      }),
      execute: async (input) => {
        const approvalRequired =
          ctx.supportsApprovals &&
          ctx.getPermissionMode() === "ask" &&
          shellNeedsApproval(input.command, input.cwd, ctx.getCwd());
        const sessionId = ctx.getSessionId();
        if (!sessionId) return { error: "no active chat session" };
        try {
          const execute = (executionId?: string) =>
            native.shellExec({
              ownerSessionId: sessionId,
              ...(executionId ? { executionId } : {}),
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
          const response = await (ctx.shellExecution
            ? ctx.shellExecution.run(execute)
            : execute());
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

function redactProcessInfo(process: ShellProcessInfo): Omit<ShellProcessInfo, "execution_id"> {
  const { execution_id: _executionId, ...publicProcess } = process;
  return {
    ...publicProcess,
    command: redactSensitive(process.command),
  };
}

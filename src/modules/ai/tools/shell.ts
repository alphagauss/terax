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
  "For a service that must keep running after Terax exits, use nohup and redirect stdin, stdout, and stderr, e.g. nohup ./server </dev/null >server.log 2>&1 & echo $!.";

/** 仅选择实际执行环境的说明，避免把宿主平台或其他连接方式写入模型工具定义。 */
const SHELL_ENVIRONMENT_DESCRIPTIONS = {
  Windows:
    "Run commands on local Windows and leave login unset or false. For a service that must keep running after Terax exits, use WMI/CIM Win32_Process.Create instead of Start-Process or Start-Job. Use absolute executable paths, set CurrentDirectory and Win32_ProcessStartup.ShowWindow=0, and redirect stdin, stdout, and stderr in the launched command. Set any required environment explicitly in that command. Check ReturnValue and ProcessId.",
  Linux: `Run commands on local Linux. ${POSIX_INDEPENDENT_SERVICE}`,
  macOS: `Run commands on local macOS. ${POSIX_INDEPENDENT_SERVICE}`,
  wsl: `Run commands and use paths inside the current WSL distribution. ${POSIX_INDEPENDENT_SERVICE}`,
  ssh: `Run commands and use paths on the current Linux SSH host. After an SSH disconnect, check the actual process state before retrying a launch or claiming cleanup succeeded. ${POSIX_INDEPENDENT_SERVICE}`,
  Unknown: "",
};

const outputOptions = {
  since_offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Byte offset for returned output and wait_for matching; defaults to 0. Reuse the returned next_offset exactly for only subsequent output; do not calculate offsets from visible output length. Use 0 to also search earlier output still retained in the buffer.",
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
      "Maximum time to wait before returning a poll or write response when wait_for is omitted: 0-30000 ms, defaults to 1000. If still running, call shell_process again to continue waiting. This does not change the process timeout.",
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
      "Use with wait_for and omit yield_time_ms. Defaults to 10000 ms. This does not change the process timeout.",
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
        "Run tests, builds, package commands, or services.\n- Initialize any required environment in command on every call, or use conda run -n <env> or a verified interpreter path. Do not assume the user's terminal environment is active.\n- For a finite command, if status=running, poll with shell_process until exit and check exit_code before claiming success. For a server or watcher, use timeout_secs=null and verify readiness without waiting for exit.\n- Use commands that work without an interactive terminal; do not start vim, less, or top.\n- Managed processes stop on timeout, execution cancellation, chat deletion, or Terax exit. Stop temporary processes before finishing; task completion alone does not stop them.\n" +
        environmentDescription +
        "\nFor an independent service, verify its PID and readiness, inspect its logs, and stop it using OS commands; shell_list and shell_process cannot manage it after its launcher exits. Only stop processes you started or were asked to manage. For services left running, report the process_id or OS PID, purpose, observed status, access address, logs, and stop command, including in subagent reports.",
      inputSchema: z.object({
        command: z
          .string()
          .min(1)
          .max(256 * 1024)
          .describe(
            "Write commands using the selected shell's syntax. Terax supplies shell startup flags; do not wrap the command in another shell unless the task requires it. If nesting shells, quote inner variables so the outer shell does not expand them." +
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
            "Set cwd whenever a command needs a specific directory; relative values resolve from the session Working directory. Omit or use null to use the chat's last remembered shell directory, initially the session directory. Setting cwd applies only to this call.",
          ),
        timeout_secs: z
          .number()
          .int()
          .min(1)
          .max(3600)
          .nullable()
          .optional()
          .describe(
            "Set the process timeout in seconds; defaults to 300. Use null for an intentionally long-running server or watcher. Finish or stop the process before this deadline; returning status=running or polling does not extend it.",
          ),
        yield_time_ms: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe(
            "Maximum time this call waits for the initial process result: 0-30000 ms, defaults to 10000. If still running, use shell_process with action=poll to continue waiting. This does not change or disable the process timeout.",
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
            'Omit or use "default" for the default shell in SESSION ENVIRONMENT. To choose another listed shell, pass its selector here and write command in its syntax. If execution fails, inspect the error; the tool does not retry with a different shell.',
          ),
        login: z
          .boolean()
          .optional()
          .describe(
            "Omit or leave false normally. Use true only to load login startup files in a supported shell. Initialize any required environment explicitly in command.",
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
        "List this chat's managed shell processes. Check before starting a server or watcher; reuse an appropriate running process instead of starting a duplicate.",
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

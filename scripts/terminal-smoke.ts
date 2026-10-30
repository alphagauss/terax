/**
 * 本文件验证终端 TS 到真实 Rust 文件与 HTTP 服务的完整 Agent 链路。
 * 模型使用临时本地服务，会话存储使用内存测试替身，不读取凭据或改动用户会话。
 */

import type { ShellIdentity } from "@/modules/ai/lib/native";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createTerminalHost } from "../cli/nativeHost";
import { installNativeHost } from "@/lib/nativeHost";
import { createAgentSession } from "@/modules/ai/lib/agentSession";
import { EMPTY_PROVIDER_KEYS } from "@/modules/ai/lib/keyring";
import { resolveAgentExecutionEnvironment } from "@/modules/ai/lib/prompt";
import { ShellExecution } from "@/modules/ai/lib/shellExecution";

const root = await mkdtemp(join(tmpdir(), "terax-agent-smoke-"));
const native = createTerminalHost(root);
const sessions = new Map<
  string,
  Record<string, unknown> & { messages: unknown[] }
>();
const locks = new Set<string>();
const trace: string[] = [];
installNativeHost({
  ...native.host,
  invoke: async <T>(command: string, args: Record<string, unknown> = {}) => {
    trace.push(command);
    if (command === "ai_session_run_acquire") {
      const id = String(args.id);
      if (locks.has(id)) return false as T;
      locks.add(id);
      return true as T;
    }
    if (command === "ai_session_run_release") {
      locks.delete(String(args.id));
      return undefined as T;
    }
    if (command === "ai_session_commit") {
      const next = args.session as Record<string, unknown> & {
        id: string;
        messages: unknown[];
        metadata: { title: string };
      };
      const previous = sessions.get(next.id);
      sessions.set(next.id, {
        ...next,
        messages: [...(previous?.messages ?? []), ...next.messages],
      });
      return {
        ...next,
        title: next.metadata.title,
        agentId: "builtin:main",
        agentName: "Terax",
        agentIcon: "coder",
      } as T;
    }
    if (command === "ai_session_read")
      return sessions.get(String(args.id)) as T;
    return native.host.invoke<T>(command, args);
  },
});

let requests = 0;
let phase: "write" | "approval" | "cancel" = "write";
const server = createServer(async (request, response) => {
  for await (const _chunk of request) {
    /* 完整消费测试请求，不记录提示词。 */
  }
  requests++;
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (phase === "cancel") {
    response.write(
      `data: ${JSON.stringify({ id: "cancel", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })}\n\n`,
    );
    return;
  }
  const tool = requests === 1;
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: "write-smoke",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: phase === "approval" ? ".env" : "result.txt",
                content: "终端链路正常\n",
                mode: "create",
              }),
            },
          },
        ],
      }
    : { content: "done" };
  response.write(
    `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
});

try {
  await native.host.invoke("host_bootstrap");
  const shells = await native.host.invoke<ShellIdentity[]>("shell_environment");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const configuration = {
    getKeys: () => ({ ...EMPTY_PROVIDER_KEYS }),
    getModel: () => ({ providerId: "builtin:ollama", modelId: "test" }),
    getEnvironment: () =>
      resolveAgentExecutionEnvironment(
        { kind: "local" },
        process.platform === "win32" ? "windows" : "linux",
        shells,
      ),
    getCustomInstructions: () => "",
    getDefaultSubagentModel: () => null,
    getMaxConcurrentSubagents: () => 3,
    getMaxAgentSteps: () => null,
    getMaxSubagentSteps: () => 32,
    getProviderBaseURLs: () => ({
      ollama: `http://127.0.0.1:${address.port}/v1`,
    }),
  };
  const session = await createAgentSession({
    cwd: root,
    permissionMode: "ask",
    configuration,
  });
  await session.send("Create result.txt, then reply done.");
  await waitFor(
    () => !session.getSnapshot().owned || Boolean(session.getSnapshot().error),
  );
  assert.equal(session.getSnapshot().error, null);
  assert.equal(
    await readFile(join(root, "result.txt"), "utf8"),
    "终端链路正常\n",
  );
  assert.equal(locks.size, 0);
  assert(trace.indexOf("ai_session_commit") < trace.indexOf("http_request"));
  assert(
    trace.includes("agent_file_prepare_mutation") &&
      trace.includes("agent_file_commit_mutation"),
  );
  const restored = await createAgentSession({
    cwd: root,
    sessionId: session.id,
    permissionMode: "ask",
    configuration,
  });
  assert(
    restored
      .getSnapshot()
      .messages.some((message) =>
        message.parts.some(
          (part) => part.type === "text" && part.text === "done",
        ),
      ),
  );
  await restored.send("Another client turn");
  await waitFor(
    () =>
      !restored.getSnapshot().owned || Boolean(restored.getSnapshot().error),
  );
  assert.equal(restored.getSnapshot().error, null);
  await session.send("Continue after the other client");
  await waitFor(
    () => !session.getSnapshot().owned || Boolean(session.getSnapshot().error),
  );
  assert.equal(session.getSnapshot().error, null);
  assert(
    session
      .getSnapshot()
      .messages.some(
        (message) =>
          message.role === "user" &&
          message.parts.some(
            (part) =>
              part.type === "text" && part.text === "Another client turn",
          ),
      ),
  );

  phase = "approval";
  requests = 0;
  const approval = await createAgentSession({
    cwd: root,
    permissionMode: "ask",
    configuration,
  });
  await approval.send("Create a sensitive file.");
  await waitFor(
    () =>
      Boolean(approval.getSnapshot().approvals[0]?.preview) ||
      Boolean(approval.getSnapshot().error),
  );
  assert.equal(approval.getSnapshot().error, null);
  assert.equal(locks.size, 1);
  await assert.rejects(stat(join(root, ".env")));
  await approval.respond(approval.getSnapshot().approvals[0].approvalId, false);
  await waitFor(
    () =>
      !approval.getSnapshot().owned || Boolean(approval.getSnapshot().error),
  );
  assert.equal(approval.getSnapshot().error, null);
  await assert.rejects(stat(join(root, ".env")));
  assert(
    approval
      .getSnapshot()
      .messages.some((message) =>
        message.parts.some(
          (part) => "state" in part && part.state === "output-denied",
        ),
      ),
  );

  phase = "cancel";
  requests = 0;
  const cancelled = await createAgentSession({
    cwd: root,
    permissionMode: "ask",
    configuration,
  });
  await cancelled.send("Keep responding until cancelled.");
  await waitFor(() =>
    cancelled
      .getSnapshot()
      .messages.some((message) =>
        message.parts.some(
          (part) => part.type === "text" && part.text === "partial",
        ),
      ),
  );
  // 与正式工具一样登记活跃执行，确保停止会话能按执行归属清理进程。
  const execution = new ShellExecution(cancelled.id);
  const processInfo = await execution.run((executionId) =>
    native.host.invoke<{ process_id: string; status: string }>("shell_exec", {
      ownerSessionId: cancelled.id,
      executionId,
      command:
        process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30",
      initialCwd: root,
      cwd: root,
      permissionMode: "ask",
      timeoutSecs: 30,
      yieldTimeMs: 10,
      maxOutputBytes: 4096,
      shell: "default",
      login: false,
    }),
  );
  assert.equal(processInfo.status, "running");
  await cancelled.stop();
  assert.equal(locks.size, 0);
  assert.equal(cancelled.getSnapshot().owned, false);
  assert(trace.includes("http_cancel"));
  // 停止会保留终态记录，验证同一进程已被终止而不是要求历史为空。
  const stoppedProcesses = await native.host.invoke<
    { process_id: string; status: string }[]
  >("shell_list", {
    ownerSessionId: cancelled.id,
    includeExited: true,
  });
  assert.deepEqual(
    stoppedProcesses.map(({ process_id, status }) => ({ process_id, status })),
    [{ process_id: processInfo.process_id, status: "terminated" }],
  );
  await execution.close();
  console.log(
    "PASS: native HTTP, tool execution, conditional write, commit order, restore, sequential client handoff, approval denial, stream cancellation, process cleanup",
  );
} finally {
  await native.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert(
    resolve(root).startsWith(`${resolve(tmpdir())}${sep}terax-agent-smoke-`),
  );
  await rm(root, { recursive: true, force: true });
}

/** 等待业务状态收敛，超时直接失败，避免测试无限挂起。 */
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    assert(Date.now() < deadline, "Agent did not settle within 15 seconds");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

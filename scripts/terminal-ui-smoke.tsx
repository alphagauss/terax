/** @jsxImportSource @opentui/react */
/**
 * 本文件验证 OpenTUI 原生渲染、中文粘贴与多行输入提交。
 * 使用框架的终端测试渲染器，不启动模型、文件工具或真实用户会话。
 */

import assert from "node:assert/strict";
import zh from "@/i18n/locales/zh-CN/tui.json";
import type {
  AgentSession,
  AgentSessionSnapshot,
} from "@/modules/ai/lib/agentSession";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { act } from "react";
import { AgentView } from "../apps/terminal/view";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const screen = await createTestRenderer({
  width: 100,
  height: 32,
  kittyKeyboard: true,
});
const sent: string[] = [];
const responses: boolean[] = [];
let acceptSend: (() => void) | undefined;
let delaySend = false;
const listeners = new Set<() => void>();
let snapshot: AgentSessionSnapshot = {
  messages: [],
  status: "idle",
  owned: false,
  approvals: [],
  error: null,
  commitFailed: false,
};
const session: AgentSession = {
  id: "test-session",
  cwd: "/tmp/terax-test",
  getSnapshot: () => snapshot,
  subscribe: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  send: async (text) => {
    sent.push(text);
    if (delaySend)
      await new Promise<void>((resolve) => {
        acceptSend = resolve;
      });
  },
  respond: async (_id, approved) => {
    responses.push(approved);
  },
  stop: async () => {},
  retrySave: async () => {},
};
try {
  await act(async () => {
    createRoot(screen.renderer).render(
      <AgentView
        session={session}
        t={(key) => zh[key]}
        close={async () => {}}
      />,
    );
  });
  await screen.flush();
  const frame = screen.captureCharFrame();
  assert(frame.includes("Terax Agent"));
  assert(frame.includes("提出问题或描述任务"));
  await screen.mockInput.pasteBracketedText("中文输入");
  screen.mockInput.pressEnter({ shift: true });
  await screen.mockInput.pasteBracketedText("第二行");
  screen.mockInput.pressEnter();
  await screen.flush();
  assert.deepEqual(sent, ["中文输入\n第二行"]);
  assert(!screen.captureCharFrame().includes("第二行"));
  delaySend = true;
  await screen.mockInput.pasteBracketedText("等待锁");
  screen.mockInput.pressEnter();
  await screen.mockInput.pasteBracketedText("期间的新内容");
  screen.mockInput.pressEnter();
  assert.equal(sent.length, 2);
  acceptSend?.();
  await screen.flush();
  assert(screen.captureCharFrame().includes("期间的新内容"));
  delaySend = false;
  screen.mockInput.pressEnter();
  await screen.flush();
  screen.resize(70, 24);
  await screen.flush();
  assert(screen.captureCharFrame().includes("Terax Agent"));
  await screen.mockInput.pasteBracketedText("保留草稿");
  await act(async () => {
    snapshot = {
      ...snapshot,
      owned: true,
      status: "awaiting-approval",
      approvals: [
        {
          sessionId: session.id,
          approvalId: "approval",
          toolCallId: "tool",
          toolName: "shell_exec",
          input: { command: "echo test" },
        },
      ],
    };
    for (const listener of listeners) listener();
  });
  await screen.flush();
  assert(screen.captureCharFrame().includes("Y 批准"));
  screen.mockInput.pressKey("y");
  await screen.flush();
  assert.deepEqual(responses, [true]);
  await act(async () => {
    snapshot = { ...snapshot, owned: false, status: "idle", approvals: [] };
    for (const listener of listeners) listener();
  });
  await screen.flush();
  assert(screen.captureCharFrame().includes("保留草稿"));
  await act(async () => {
    snapshot = {
      ...snapshot,
      messages: Array.from({ length: 50 }, (_, index) => ({
        id: String(index),
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: `消息${index}` }],
      })),
    };
    for (const listener of listeners) listener();
  });
  await screen.flush();
  assert(screen.captureCharFrame().includes("消息49"));
  screen.mockInput.pressKey("\x1b[5~");
  await screen.flush();
  assert(!screen.captureCharFrame().includes("消息49"));
  screen.mockInput.pressKey("\x1b[6~");
  await screen.flush();
  assert(screen.captureCharFrame().includes("消息49"));
  console.log(
    "PASS: native TUI rendering, Chinese paste, multiline submit, clear-on-accept, resize, approval focus, draft retention, keyboard scrolling",
  );
} finally {
  await act(async () => {
    screen.renderer.destroy();
  });
}

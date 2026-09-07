/** @jsxImportSource @opentui/react */
/**
 * 本文件实现终端 Agent 的消息、输入与审批界面。
 * 仅订阅共享会话状态并提交用户操作，不负责模型执行和会话落盘。
 */

import type {
  AgentSession,
  SessionApproval,
} from "@/modules/ai/lib/agentSession";
import {
  createCliRenderer,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import type { UIMessage } from "ai";
import { createTwoFilesPatch } from "diff";
import { useRef, useState, useSyncExternalStore } from "react";
import type { TerminalText } from "../settings";

/** 启动独立 TUI，退出时先完成宿主清理，再恢复终端显示模式。 */
export async function showAgent(
  session: AgentSession,
  t: TerminalText,
  onClose: () => Promise<void>,
) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await onClose();
    } finally {
      renderer.destroy();
    }
  };
  createRoot(renderer).render(
    <AgentView session={session} t={t} close={close} />,
  );
}

/** 展示运行状态，键盘操作只调用会话控制器。 */
export function AgentView({
  session,
  t,
  close,
}: {
  session: AgentSession;
  t: TerminalText;
  close: () => Promise<void>;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const input = useRef<TextareaRenderable>(null);
  const submitting = useRef(false);
  const transcript = useRef<ScrollBoxRenderable>(null);
  const approvalScroll = useRef<ScrollBoxRenderable>(null);
  const [error, setError] = useState<string | null>(null);
  const approval = state.approvals[0];
  const perform = (operation: Promise<unknown>) => {
    void operation.catch((failure: unknown) => setError(String(failure)));
  };
  useKeyboard((key) => {
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      (approval ? approvalScroll.current : transcript.current)?.scrollBy(
        key.name === "pageup" ? -10 : 10,
      );
      return;
    }
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      perform(state.owned && !state.commitFailed ? session.stop() : close());
    } else if (key.name === "escape" && state.owned) {
      key.preventDefault();
      perform(session.stop());
    } else if (key.ctrl && key.name === "r" && state.commitFailed) {
      key.preventDefault();
      perform(session.retrySave());
    } else if (
      approval &&
      !key.ctrl &&
      (key.name === "y" || key.name === "n")
    ) {
      key.preventDefault();
      perform(session.respond(approval.approvalId, key.name === "y"));
    }
  });
  const submit = () => {
    const text = input.current?.plainText.trim();
    if (!text || state.owned || submitting.current) return;
    if (text === "/exit") {
      perform(close());
      return;
    }
    if (text.startsWith("/")) {
      setError(t("unknownCommand"));
      return;
    }
    setError(null);
    submitting.current = true;
    perform(
      session
        .send(text)
        .then(() => {
          // 等待会话锁期间仍可编辑草稿，只清空已经提交且未再修改的内容。
          if (input.current?.plainText.trim() === text) input.current.clear();
        })
        .finally(() => {
          submitting.current = false;
        }),
    );
  };
  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      padding={1}
      gap={1}
      backgroundColor="#10141c"
    >
      <box flexDirection="column" flexShrink={0}>
        <text fg="#8bb8ff">
          <strong>{t("title")}</strong> {session.cwd}
        </text>
        <text fg="#8b96a8">{t("session", { id: session.id })}</text>
      </box>
      <scrollbox
        ref={transcript}
        flexGrow={approval ? 0 : 1}
        height={approval ? 0 : undefined}
        visible={!approval}
        stickyScroll
        stickyStart="bottom"
        focused={false}
      >
        {state.messages.length === 0 && <text fg="#8b96a8">{t("empty")}</text>}
        {state.messages.map((message) => (
          <box key={message.id} flexDirection="column" marginBottom={1}>
            <text fg={message.role === "user" ? "#8bb8ff" : "#9fd0a3"}>
              {t(message.role === "user" ? "user" : "assistant")}
            </text>
            <Message message={message} t={t} />
          </box>
        ))}
      </scrollbox>
      {approval && (
        <box
          flexDirection="column"
          border
          borderColor="#d8b66a"
          padding={1}
          flexGrow={1}
          minHeight={0}
        >
          <text fg="#d8b66a">{t("approval", { tool: approval.toolName })}</text>
          <scrollbox ref={approvalScroll} flexGrow={1} focused>
            <Approval request={approval} t={t} />
          </scrollbox>
          <text fg="#d8b66a">{t("approvalKeys")}</text>
        </box>
      )}
      {(error || state.error) && (
        <text fg="#ef9393">{error ?? state.error}</text>
      )}
      {state.commitFailed && <text fg="#ef9393">{t("saveFailed")}</text>}
      <text fg="#8b96a8">
        {state.owned && state.status === "idle" ? t("saving") : t(state.status)}
      </text>
      <box
        border
        borderColor="#47566d"
        height={approval ? 0 : 5}
        visible={!approval}
        flexShrink={0}
      >
        <textarea
          ref={input}
          focused={!approval}
          flexGrow={1}
          placeholder={t("input")}
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "return", shift: true, action: "newline" },
          ]}
          onSubmit={submit}
        />
      </box>
      <text fg="#8b96a8" visible={!approval}>
        {t("keys")}
      </text>
    </box>
  );
}

/** 仅呈现会话的用户可见消息片段，内部 checkpoint 不进入聊天正文。 */
function Message({ message, t }: { message: UIMessage; t: TerminalText }) {
  return (
    <>
      {message.parts.map((part, index) => {
        if (part.type === "text")
          return (
            // 流式消息的 part 仅追加，位置是其稳定身份。
            // biome-ignore lint/suspicious/noArrayIndexKey: SDK 流片段按顺序追加，不重排。
            <text key={index} fg="#d9e1ed">
              {part.text}
            </text>
          );
        if ("toolCallId" in part) {
          const name =
            part.type === "dynamic-tool"
              ? part.toolName
              : part.type.replace(/^tool-/, "");
          const output =
            "output" in part
              ? part.output
              : "errorText" in part
                ? part.errorText
                : undefined;
          return (
            <box key={part.toolCallId} flexDirection="column">
              <text fg="#8b96a8">
                {name} · {t(part.state)}
              </text>
              {output !== undefined && (
                <text fg="#a8b4c5">
                  {(typeof output === "string"
                    ? output
                    : JSON.stringify(output, null, 2)
                  ).slice(0, 8192)}
                </text>
              )}
            </box>
          );
        }
        return null;
      })}
    </>
  );
}

/** 展示完整待批准参数或文件差异，预览失败时仅允许拒绝。 */
function Approval({
  request,
  t,
}: {
  request: SessionApproval;
  t: TerminalText;
}) {
  if (request.error) return <text fg="#ef9393">{request.error}</text>;
  if (request.preview)
    return (
      <>
        {request.preview.files.map((file) => (
          <box key={file.path} flexDirection="column">
            <text fg="#8bb8ff">{file.path}</text>
            <diff
              diff={createTwoFilesPatch(
                file.path,
                file.path,
                file.before,
                file.after,
              )}
              view="unified"
            />
          </box>
        ))}
      </>
    );
  if (request.toolName === "write_file" || request.toolName === "apply_patch")
    return <text>{t("preparing")}</text>;
  return <text>{JSON.stringify(request.input, null, 2)}</text>;
}

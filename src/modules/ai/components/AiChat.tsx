/**
 * 本文件实现 AI 会话消息列表、等待反馈、滚动记忆以及正文、活动块和 Subagent 分段渲染。
 * 工具详情在会话层统一提供可见滚动条和 Shift 加滚轮的横向滚动。
 * 内部结果、展示耗时和 Subagent 展示事件不参与普通分组。
 * 历史消息和已完成工具保持稳定且默认折叠。
 */
import { DeliveryCard } from "@/modules/channels/components/DeliveryCard";
import {
  EMPTY_DELIVERIES,
  useDeliveryHistory,
} from "@/modules/channels/history";

import { MessageAttachments } from "@/modules/ai/components/MessageAttachments";
import { messageTextWithoutAttachments } from "@/modules/ai/lib/messageAttachments";
import { TurnMetrics } from "@/modules/ai/components/TurnMetrics";
import { CONTEXT_BUDGET_ERROR } from "@/modules/ai/lib/errors";
import { ChatMessageResponse } from "@/modules/ai/components/ChatMessageResponse";
import { FileEditContext } from "@/modules/ai/components/FileEditStats";
import { FileEditTool } from "@/modules/ai/components/FileEditTool";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@/components/ai-elements/message";
import { Tool } from "@/components/ai-elements/tool";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import i18n from "@/i18n";
import { cn } from "@/lib/utils";
import { displayAgent } from "@/modules/agents/lib/format";
import type { SubagentDisplaySnapshot } from "@/modules/ai/agents/subagentDisplay";
import { AiChatScrollControls } from "@/modules/ai/components/AiChatScrollControls";
import {
  ChatActivityBlock,
  type ChatActivityHeadline,
} from "@/modules/ai/components/ChatActivityBlock";
import { ChatCollapsibleScrollGuard } from "@/modules/ai/components/ChatCollapsibleScrollGuard";
import { ChatReasoningPart } from "@/modules/ai/components/ChatReasoningPart";
import { ChatStatusDots } from "@/modules/ai/components/ChatStatusDots";
import {
  SubagentCard,
  type SubagentResultView,
} from "@/modules/ai/components/SubagentCard";
import { CHAT_SCROLL_SPRING } from "@/modules/ai/lib/chatScroll";
import {
  activityDurationFromPart,
  messageMetadata,
  projectConversationDisplay,
  reasoningDurationFromPart,
} from "@/modules/ai/lib/conversation";
import { formatMessageTimestamp } from "@/modules/ai/lib/messageTimestamp";
import { EMPTY_COMMANDS, useCommandStore } from "@/modules/ai/commands/store";
import type { CommandDisplay } from "@/modules/ai/commands/records";
import { sendMessage } from "@/modules/ai/store/chatRuntime";
import {
  getAgentMetaForSession,
  useChatStore,
} from "@/modules/ai/store/chatStore";
import { useSessionAttentionStore } from "@/modules/ai/store/sessionAttentionStore";
import {
  ArrowRight01Icon,
  CodeIcon,
  Copy01Icon,
  File01Icon,
  HashtagIcon,
  TerminalIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  ChatStatus,
  DynamicToolUIPart,
  ToolUIPart,
  UIMessage,
  UIMessagePart,
} from "ai";
import {
  Fragment,
  memo,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { StickToBottomContext } from "use-stick-to-bottom";

const FileEditsCard = lazy(() =>
  import("@/modules/ai/components/FileEditsCard").then((module) => ({
    default: module.FileEditsCard,
  })),
);

type ConversationScrollPosition = {
  top: number;
  atBottom: boolean;
  anchor: {
    messageId: string;
    offset: number;
  } | null;
};

const conversationScrollPositions = new Map<
  string,
  ConversationScrollPosition
>();

/** 记忆并恢复会话滚动位置，滚动事件按动画帧合并，底部状态不采集消息锚点。 */
function useConversationScrollMemory(sessionId: string) {
  const contextRef = useRef<StickToBottomContext | null>(null);
  const remembered = conversationScrollPositions.get(sessionId);
  const revealLatest = useSessionAttentionStore((state) =>
    Boolean(state.revealLatestBySession[sessionId]),
  );

  useLayoutEffect(() => {
    let bindFrame = 0;
    let saveFrame = 0;
    let disposed = false;
    let element: HTMLElement | null = null;
    let saveNow: (() => void) | null = null;
    let handleScroll: (() => void) | null = null;

    const bind = () => {
      const context = contextRef.current;
      element = context?.scrollRef.current ?? null;
      if (!context || !element) {
        bindFrame = window.requestAnimationFrame(bind);
        return;
      }

      const savePosition = () => {
        if (!element) return;
        const remaining =
          element.scrollHeight - element.clientHeight - element.scrollTop;
        const atBottom = remaining <= 4;
        conversationScrollPositions.set(sessionId, {
          top: element.scrollTop,
          atBottom,
          anchor: atBottom ? null : findConversationAnchor(element),
        });
      };
      const scheduleSave = () => {
        if (saveFrame !== 0) return;
        saveFrame = window.requestAnimationFrame(() => {
          saveFrame = 0;
          savePosition();
        });
      };
      saveNow = savePosition;
      handleScroll = scheduleSave;

      const saved = conversationScrollPositions.get(sessionId);
      if (saved && !saved.atBottom) {
        context.stopScroll();
        const restore = () => {
          if (!element) return;
          context.stopScroll();
          const maxScrollTop = Math.max(
            0,
            element.scrollHeight - element.clientHeight,
          );
          const anchorElement = saved.anchor
            ? findConversationMessage(element, saved.anchor.messageId)
            : null;
          if (anchorElement && saved.anchor) {
            const viewportTop = element.getBoundingClientRect().top;
            const currentOffset =
              anchorElement.getBoundingClientRect().top - viewportTop;
            element.scrollTop = Math.min(
              maxScrollTop,
              Math.max(
                0,
                element.scrollTop + currentOffset - saved.anchor.offset,
              ),
            );
            return;
          }
          element.scrollTop = Math.min(saved.top, maxScrollTop);
        };
        restore();
        queueMicrotask(() => {
          if (disposed) return;
          restore();
          element?.addEventListener("scroll", scheduleSave, { passive: true });
        });
        return;
      }

      element.addEventListener("scroll", scheduleSave, { passive: true });
    };

    bind();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(bindFrame);
      window.cancelAnimationFrame(saveFrame);
      if (element && handleScroll) {
        element.removeEventListener("scroll", handleScroll);
      }
      saveNow?.();
    };
  }, [sessionId]);

  useLayoutEffect(() => {
    if (
      !revealLatest ||
      !useSessionAttentionStore.getState().takeRevealLatest(sessionId)
    ) {
      return;
    }
    conversationScrollPositions.delete(sessionId);
    const frame = window.requestAnimationFrame(() => {
      void contextRef.current?.scrollToBottom({
        animation: "instant",
        ignoreEscapes: true,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [revealLatest, sessionId]);

  return {
    contextRef,
    initial: remembered?.atBottom === false ? false : ("instant" as const),
  };
}

function conversationMessages(element: HTMLElement): HTMLElement[] {
  return Array.from(
    element.querySelectorAll<HTMLElement>("[data-conversation-message-id]"),
  );
}

function findConversationAnchor(element: HTMLElement): {
  messageId: string;
  offset: number;
} | null {
  const viewportTop = element.getBoundingClientRect().top;
  const anchor = conversationMessages(element).find(
    (message) => message.getBoundingClientRect().bottom > viewportTop,
  );
  const messageId = anchor?.dataset.conversationMessageId;
  if (!anchor || !messageId) return null;
  return {
    messageId,
    offset: anchor.getBoundingClientRect().top - viewportTop,
  };
}

function findConversationMessage(
  element: HTMLElement,
  messageId: string,
): HTMLElement | null {
  return (
    conversationMessages(element).find(
      (message) => message.dataset.conversationMessageId === messageId,
    ) ?? null
  );
}

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

type ContextChip =
  | { kind: "selection"; source: "terminal" | "editor"; lines: number }
  | { kind: "snippet"; name: string };

const SELECTION_RE =
  /<selection\s+source="(terminal|editor)">\n?([\s\S]*?)\n?<\/selection>/g;
const SNIPPET_RE = /<snippet\s+name="([^"]+)">\n?[\s\S]*?\n?<\/snippet>/g;

function countLines(s: string): number {
  if (!s) return 0;
  const trimmed = s.replace(/\n+$/, "");
  if (!trimmed) return 0;
  return trimmed.split("\n").length;
}

function stripUserContextBlocks(text: string): {
  text: string;
  chips: ContextChip[];
} {
  const chips: ContextChip[] = [];
  let out = text;
  out = out.replace(SELECTION_RE, (_m, source: string, body: string) => {
    chips.push({
      kind: "selection",
      source: source === "editor" ? "editor" : "terminal",
      lines: countLines(body),
    });
    return "";
  });
  out = out.replace(SNIPPET_RE, (_m, name: string) => {
    chips.push({ kind: "snippet", name });
    return "";
  });
  return { text: out.trim(), chips };
}

const ContextChips = memo(function ContextChips({
  chips,
}: {
  chips: ContextChip[];
}) {
  return (
    <div className="mb-1 flex flex-wrap gap-1">
      {chips.map((c, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-card/60 px-1.5 py-0.5 text-[10.5px] text-muted-foreground"
        >
          {chipIcon(c)}
          <span className="font-medium text-foreground">{chipLabel(c)}</span>
          {"lines" in c && c.lines > 0 ? (
            <span className="text-muted-foreground">· {c.lines}L</span>
          ) : null}
        </span>
      ))}
    </div>
  );
});

function chipIcon(c: ContextChip) {
  if (c.kind === "selection") {
    return (
      <HugeiconsIcon
        icon={c.source === "editor" ? CodeIcon : TerminalIcon}
        size={10}
        strokeWidth={1.75}
      />
    );
  }
  return <HugeiconsIcon icon={HashtagIcon} size={10} strokeWidth={1.75} />;
}

function chipLabel(c: ContextChip): string {
  if (c.kind === "selection") {
    return c.source === "editor"
      ? i18n.t("ai:chat.editorSelection")
      : i18n.t("ai:chat.terminalSelection");
  }
  return `#${c.name}`;
}
type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

type Props = {
  sessionId: string;
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  clearError: () => void;
};

/**
 * AI 会话消息视图。
 *
 * 仅在前台挂载，负责恢复滚动位置、按引导切开活动块和渲染流式末尾消息。
 */
export function AiChatView({
  sessionId,
  messages: sourceMessages,
  status,
  error,
  clearError,
}: Props) {
  const { t } = useTranslation("ai");
  const scrollMemory = useConversationScrollMemory(sessionId);
  const isBusy = status === "submitted" || status === "streaming";
  const messages = useMemo(
    () => projectConversationDisplay(sourceMessages),
    [sourceMessages],
  );
  const commands = useCommandStore(
    (state) => state.sessions[sessionId] ?? EMPTY_COMMANDS,
  );
  const deliveries = useDeliveryHistory(
    (state) => state.sessions[sessionId] ?? EMPTY_DELIVERIES,
  );
  const attachedDeliveries = deliveries.filter(
    (entry) =>
      entry.source === "agent" &&
      messages.some(
        (message) =>
          message.id === entry.afterMessageId &&
          message.role === "assistant" &&
          message.parts
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n") === entry.content.text,
      ),
  );
  const activities = [
    ...commands.map((command) => ({
      ...command,
      element: <CommandCard key={command.id} command={command} />,
    })),
    ...deliveries
      .filter((entry) => !attachedDeliveries.includes(entry))
      .map((entry) => ({
        ...entry,
        element: <DeliveryCard key={entry.id} entry={entry} />,
      })),
  ].sort((a, b) => a.timestamp - b.timestamp);
  const lastMessage = messages[messages.length - 1];
  const showPendingResponse =
    isBusy &&
    (lastMessage?.role === "user" ||
      (lastMessage?.role === "assistant" &&
        !hasVisibleAssistantOutput(lastMessage.parts as AnyPart[])));
  const pendingAssistantMessageId =
    showPendingResponse && lastMessage?.role === "assistant"
      ? lastMessage.id
      : null;
  const streamingMessageId =
    status === "streaming" && lastMessage?.role === "assistant"
      ? lastMessage.id
      : null;
  const meta = useChatStore((state) =>
    getAgentMetaForSession(state, sessionId),
  );
  const { hitStepCap, compactionNotice } = meta;
  const patchAgentMeta = useChatStore((s) => s.patchAgentMeta);
  const showContinue =
    !isBusy && hitStepCap && lastMessage?.role === "assistant";

  const setToolDetailsWheelScope = useCallback(
    (scope: HTMLDivElement | null) => {
      if (!scope) return;

      scope.addEventListener("wheel", handleToolDetailsWheel, {
        passive: false,
      });
      return () => scope.removeEventListener("wheel", handleToolDetailsWheel);
    },
    [],
  );

  if (
    messages.length === 0 &&
    commands.length === 0 &&
    deliveries.length === 0
  ) {
    return (
      <Conversation
        contextRef={scrollMemory.contextRef}
        initial={scrollMemory.initial}
        resize="instant"
      >
        <ConversationContent scrollClassName="app-scrollbar [scrollbar-gutter:stable]">
          <ConversationEmptyState
            title={t("chat.emptyTitle")}
            description={t("chat.emptyDescription")}
          />
        </ConversationContent>
      </Conversation>
    );
  }

  return (
    <Conversation
      contextRef={scrollMemory.contextRef}
      initial={scrollMemory.initial}
      resize={CHAT_SCROLL_SPRING}
      {...CHAT_SCROLL_SPRING}
    >
      <ChatCollapsibleScrollGuard />
      <ConversationContent
        className="gap-4 p-3"
        scrollClassName="app-scrollbar [scrollbar-gutter:stable]"
      >
        <div ref={setToolDetailsWheelScope} className="contents">
          {activities
            .filter(
              (entry) =>
                !entry.afterMessageId ||
                !messages.some(
                  (message) => message.id === entry.afterMessageId,
                ),
            )
            .map((entry) => entry.element)}
          {messages.map((m) => (
            <Fragment key={m.id}>
              {m.id !== pendingAssistantMessageId &&
              !messageMetadata(m).commandId ? (
                <RenderedMessage
                  sessionId={sessionId}
                  message={m}
                  streaming={m.id === streamingMessageId}
                />
              ) : null}
              {attachedDeliveries
                .filter((entry) => entry.afterMessageId === m.id)
                .map((entry) => (
                  <DeliveryCard key={entry.id} entry={entry} compact />
                ))}
              {activities
                .filter((entry) => entry.afterMessageId === m.id)
                .map((entry) => entry.element)}
            </Fragment>
          ))}
        </div>
        {compactionNotice && (
          <CompactionNotice
            droppedCount={compactionNotice.droppedCount}
            onDismiss={() =>
              patchAgentMeta(sessionId, { compactionNotice: null })
            }
          />
        )}
        {showPendingResponse ? (
          <div
            className="flex h-[22px] items-center text-foreground"
            role="status"
            aria-label={t("chat.thinking")}
          >
            <ChatStatusDots />
          </div>
        ) : null}
        {showContinue && (
          <ContinueRow
            onContinue={() => {
              patchAgentMeta(sessionId, { hitStepCap: false });
              void sendMessage(t("chat.continuePrompt"));
            }}
          />
        )}
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <div className="font-medium">{t("chat.somethingWentWrong")}</div>
            <div className="mt-0.5 leading-relaxed">
              {error.message.includes(CONTEXT_BUDGET_ERROR)
                ? t("chat.contextBudgetExceeded")
                : error.message}
            </div>
            <button
              type="button"
              onClick={clearError}
              className="mt-1 underline"
            >
              {t("chat.dismiss")}
            </button>
          </div>
        )}
      </ConversationContent>
      <AiChatScrollControls messages={messages} running={isBusy} />
    </Conversation>
  );
}

/** 命令卡只展示持久化操作和回执，不提供模型轮次操作。 */
function CommandCard({ command }: { command: CommandDisplay }) {
  const { t } = useTranslation("ai");
  const status = command.result
    ? command.result.status === "error"
      ? t("commands.failed")
      : t(
          command.result.taskMessageId
            ? "commands.submitted"
            : "commands.completed",
        )
    : t(
        command.pending === "waiting"
          ? "commands.waiting"
          : command.pending === "running"
            ? "commands.running"
            : "commands.unconfirmed",
      );
  return (
    <div
      data-conversation-message-id={command.id}
      className="group/message rounded-md border border-border bg-muted/30 px-3 py-2 text-xs"
    >
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{t("commands.label")}</span>
        <code className="min-w-0 flex-1 whitespace-pre-wrap break-words">
          {command.input}
        </code>
        <span
          className={
            command.result?.status === "error"
              ? "text-destructive"
              : "text-muted-foreground"
          }
        >
          {status}
        </span>
      </div>
      {command.result ? (
        <p className="mt-2 whitespace-pre-wrap break-words">
          {command.result.text}
        </p>
      ) : null}
      <MessageMeta
        timestamp={command.timestamp}
        copyText={[command.input, command.result?.text]
          .filter(Boolean)
          .join("\n")}
      />
    </div>
  );
}

const CompactionNotice = memo(function CompactionNotice({
  droppedCount,
  onDismiss,
}: {
  droppedCount: number;
  onDismiss: () => void;
}) {
  const { t } = useTranslation("ai");
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <span className="size-1.5 shrink-0 rounded-full bg-warning/80" />
      <span className="flex-1 truncate">
        {t("chat.contextCompacted", { count: droppedCount })}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="text-[10.5px] underline"
      >
        {t("chat.dismiss")}
      </button>
    </div>
  );
});

const ContinueRow = memo(function ContinueRow({
  onContinue,
}: {
  onContinue: () => void;
}) {
  const { t } = useTranslation("ai");
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/50 bg-card/60 px-2.5 py-1.5 text-[11px]">
      <span className="flex-1 text-muted-foreground">
        {t("chat.hitStepLimit")}
      </span>
      <button
        type="button"
        onClick={onContinue}
        className="rounded-md border border-border/60 bg-background px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
      >
        {t("chat.continue")}
      </button>
    </div>
  );
});

const RenderedMessage = memo(function RenderedMessage({
  sessionId,
  message,
  streaming,
}: {
  sessionId: string;
  message: UIMessage;
  streaming: boolean;
}) {
  const { t } = useTranslation("ai");
  // AI SDK 只会继续修改末尾 part；更早的正文和推理块已经终结，
  // 不应因后续工具调用继续显示流式状态。
  const streamingPartIdx = streaming ? message.parts.length - 1 : -1;
  const groups = useMemo(
    () =>
      message.role === "user"
        ? []
        : buildMessageGroups(message.parts as AnyPart[]),
    [message.parts, message.role],
  );
  const timestamp = useMessageTimestamp(message);
  const copyText = useMemo(() => messageTextForCopy(message), [message]);
  const subagentParts = messageMetadata(message).subagents;
  const fileEdits = messageMetadata(message).fileEdits;
  const fileEditContext = useMemo(
    () => ({ sessionId, calls: fileEdits?.calls }),
    [sessionId, fileEdits?.calls],
  );
  if (message.role === "user") {
    const rawText = messageTextWithoutAttachments(message);

    const stripped = stripUserContextBlocks(rawText);

    return (
      <Message
        from="user"
        data-conversation-message-id={message.id}
        className="group/message"
      >
        <MessageAttachments message={message} />
        {stripped.text ||
        stripped.chips.length ||
        messageMetadata(message).guided ? (
          <MessageContent className="group-[.is-user]:bg-secondary group-[.is-user]:text-secondary-foreground">
            {messageMetadata(message).guided ? (
              <span className="mb-1 inline-flex rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
                {t("chat.guided")}
              </span>
            ) : null}
            {stripped.chips.length > 0 ? (
              <ContextChips chips={stripped.chips} />
            ) : null}
            {stripped.text ? (
              <p className="whitespace-pre-wrap wrap-break-word">
                {stripped.text}
              </p>
            ) : null}
          </MessageContent>
        ) : null}
        <MessageMeta timestamp={timestamp} copyText={copyText} />
      </Message>
    );
  }

  return (
    <FileEditContext.Provider value={fileEditContext}>
      <Message
        from={message.role}
        data-conversation-message-id={message.id}
        className="group/message gap-1"
      >
        <MessageContent>
          <div className="flex flex-col gap-0.5 [&>div:has(.ai-activity-block)+div:has(.markdown-content)]:mt-4">
            {groups.map((g) => {
              if (g.kind === "activity") {
                return (
                  <PartAppear key={`${message.id}-${g.key}`}>
                    <ChatActivityBlock
                      durationMs={g.durationMs}
                      headline={activityHeadline(
                        g.headlinePart,
                        t("chat.activity.thinking"),
                      )}
                      running={streaming && !g.completed}
                    >
                      {g.groups.map((group) => (
                        <RenderedLeafGroup
                          key={`${message.id}-${group.key}`}
                          group={group}
                          message={message}
                          sessionId={sessionId}
                          streaming={streaming}
                          streamingPartIdx={streamingPartIdx}
                          subagentParts={subagentParts}
                        />
                      ))}
                    </ChatActivityBlock>
                  </PartAppear>
                );
              }
              return (
                <RenderedLeafGroup
                  key={`${message.id}-${g.key}`}
                  group={g}
                  message={message}
                  sessionId={sessionId}
                  streaming={streaming}
                  streamingPartIdx={streamingPartIdx}
                  subagentParts={subagentParts}
                />
              );
            })}
          </div>
          {messageMetadata(message).fileEditsSummary && fileEdits && (
            <Suspense fallback={null}>
              <FileEditsCard sessionId={sessionId} edits={fileEdits} />
            </Suspense>
          )}
        </MessageContent>
        {!streaming ? (
          <MessageMeta
            timestamp={timestamp}
            copyText={copyText}
            sessionId={sessionId}
            turnId={messageMetadata(message).turnId}
          />
        ) : null}
      </Message>
    </FileEditContext.Provider>
  );
});

const RenderedLeafGroup = memo(function RenderedLeafGroup({
  group,
  message,
  sessionId,
  streaming,
  streamingPartIdx,
  subagentParts,
}: {
  group: LeafGroup;
  message: UIMessage;
  sessionId: string;
  streaming: boolean;
  streamingPartIdx: number;
  subagentParts: ReturnType<typeof messageMetadata>["subagents"];
}) {
  if (group.kind === "reads") {
    return (
      <PartAppear>
        <ReadGroup parts={group.parts} />
      </PartAppear>
    );
  }
  const isReadSingle =
    partType(group.part) === "tool-read_file" &&
    ((group.part as { state?: string }).state ?? "") !== "approval-requested";
  if (isReadSingle) {
    return (
      <PartAppear>
        <ReadRow part={group.part} />
      </PartAppear>
    );
  }
  return (
    <PartAppear>
      <RenderedPart
        sessionId={sessionId}
        part={group.part}
        streaming={group.idx === streamingPartIdx}
        reasoningStreaming={
          streaming &&
          group.part.type === "reasoning" &&
          (group.part as { state?: string }).state === "streaming"
        }
        autoCollapseReasoning={
          group.part.type === "reasoning" &&
          (group.part as { state?: string }).state === "done" &&
          (hasVisiblePartAfter(message.parts as AnyPart[], group.idx) ||
            !streaming)
        }
        reasoningDurationMs={reasoningDurationFromPart(
          message.parts[group.idx + 1],
        )}
        persistedSubagent={subagentParts?.displaysByToolCallId.get(
          toolCallIdFromPart(group.part),
        )}
        subagentResult={subagentResultForPart(
          group.part,
          subagentParts?.resultsByTaskId,
        )}
      />
    </PartAppear>
  );
});

/** 读取消息持久化元数据中的创建时间，流式消息首次渲染时使用当前时间作为临时值。 */
function useMessageTimestamp(message: UIMessage): number {
  const [renderedAt] = useState(() => Date.now());
  const createdAt = (message.metadata as { createdAt?: unknown } | undefined)
    ?.createdAt;
  return typeof createdAt === "number" && Number.isFinite(createdAt)
    ? createdAt
    : renderedAt;
}

/** 提取用户或助手可见的正文，复制时不包含注入的终端、选区和文件上下文。 */
function messageTextForCopy(message: UIMessage): string {
  if (message.role !== "user") {
    return message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  return stripUserContextBlocks(messageTextWithoutAttachments(message)).text;
}

/** 消息底部的时间、复制操作与最终回答的本轮统计入口。 */
const MessageMeta = memo(function MessageMeta({
  timestamp,
  copyText,
  sessionId,
  turnId,
}: {
  timestamp: number;
  copyText: string;
  sessionId?: string;
  turnId?: string;
}) {
  const { t, i18n } = useTranslation("ai");
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);
  const label = formatMessageTimestamp(timestamp, i18n.language);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  const copy = useCallback(async () => {
    if (!copyText || typeof navigator === "undefined") return;
    try {
      await navigator.clipboard.writeText(copyText);
    } catch {
      return;
    }
    setCopied(true);
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => {
      resetTimer.current = null;
      setCopied(false);
    }, 3000);
  }, [copyText]);

  return (
    <MessageActions
      className={cn(
        "h-5 gap-0.5 text-[10px] text-muted-foreground opacity-0 transition-opacity duration-control",
        "pointer-events-none group-hover/message:pointer-events-auto group-hover/message:opacity-100",
        "group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100",
      )}
    >
      {label ? (
        <time dateTime={new Date(timestamp).toISOString()}>{label}</time>
      ) : null}
      <MessageAction
        tooltip={copied ? t("chat.copied") : t("chat.copy")}
        label={copied ? t("chat.copied") : t("chat.copy")}
        onClick={() => void copy()}
        disabled={!copyText}
        className="size-5 text-muted-foreground hover:text-foreground"
      >
        <HugeiconsIcon
          icon={copied ? Tick02Icon : Copy01Icon}
          size={12}
          strokeWidth={1.75}
        />
      </MessageAction>
      {sessionId && turnId && (
        <TurnMetrics sessionId={sessionId} turnId={turnId} />
      )}
    </MessageActions>
  );
});

type LeafGroup =
  | { kind: "single"; part: AnyPart; idx: number; key: string }
  | { kind: "reads"; parts: AnyPart[]; key: string };

type ActivityGroup = {
  kind: "activity";
  key: string;
  groups: LeafGroup[];
  headlinePart: AnyPart;
  durationMs?: number;
  completed: boolean;
};

type MessageGroup = LeafGroup | ActivityGroup;

function partType(p: AnyPart): string {
  return (p as { type?: string }).type ?? "";
}

function isReadFilePart(p: AnyPart): boolean {
  if (partType(p) !== "tool-read_file") return false;
  const state = (p as { state?: string }).state ?? "";
  return state !== "approval-requested";
}

function partKey(p: AnyPart, idx: number): string {
  const tc = (p as { toolCallId?: string }).toolCallId;
  if (tc) return tc;
  const id = (p as { approval?: { id?: string } }).approval?.id;
  if (id) return id;
  return `i-${idx}`;
}

/** 将正文和 Subagent 之间的其余可展示内容归入独立活动块。 */
export function buildMessageGroups(parts: AnyPart[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let plain: { parts: AnyPart[]; startIndex: number } | undefined;
  let activity:
    | {
        parts: AnyPart[];
        startIndex: number;
        headlinePart: AnyPart;
        durationMs?: number;
      }
    | undefined;

  const flushPlain = () => {
    if (!plain) return;
    groups.push(...buildPartGroups(plain.parts, plain.startIndex));
    plain = undefined;
  };
  const flushActivity = (completed = true) => {
    if (!activity) return;
    groups.push({
      kind: "activity",
      key: `activity-${partKey(
        parts[activity.startIndex],
        activity.startIndex,
      )}`,
      groups: buildPartGroups(activity.parts, activity.startIndex),
      headlinePart: activity.headlinePart,
      durationMs: activity.durationMs,
      completed,
    });
    activity = undefined;
  };
  const appendPlain = (part: AnyPart, index: number) => {
    plain ??= { parts: [], startIndex: index };
    plain.parts.push(part);
  };

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const durationMs = activityDurationFromPart(part);
    if (durationMs !== undefined) {
      if (activity) {
        activity.durationMs = (activity.durationMs ?? 0) + durationMs;
      } else {
        // 实时耗时可能紧跟 text part，恢复后的同一标记则位于正文前。
        const previous = groups[groups.length - 1];
        if (previous?.kind === "activity") {
          previous.durationMs = (previous.durationMs ?? 0) + durationMs;
        }
      }
      continue;
    }
    if (isActivityBoundary(part)) {
      flushActivity();
      appendPlain(part, index);
      continue;
    }

    if (!activity && isVisibleActivityPart(part)) {
      flushPlain();
      activity = {
        parts: [],
        startIndex: index,
        headlinePart: part,
      };
    }
    if (activity) {
      activity.parts.push(part);
      if (partType(part) === "reasoning" || isToolPart(part)) {
        activity.headlinePart = part;
      }
    } else {
      appendPlain(part, index);
    }
  }

  flushActivity(false);
  flushPlain();
  return groups;
}

function buildPartGroups(parts: AnyPart[], offset = 0): LeafGroup[] {
  const out: LeafGroup[] = [];
  let run: { parts: AnyPart[]; startIdx: number } | null = null;
  const flushRun = () => {
    if (!run) return;
    if (run.parts.length >= 2) {
      out.push({
        kind: "reads",
        parts: run.parts,
        key: `reads-${partKey(run.parts[0], run.startIdx)}`,
      });
    } else {
      const startIdx = run.startIdx;
      run.parts.forEach((p, k) => {
        const idx = startIdx + k;
        out.push({ kind: "single", part: p, idx, key: partKey(p, idx) });
      });
    }
    run = null;
  };
  parts.forEach((p, localIndex) => {
    const i = localIndex + offset;
    if (
      reasoningDurationFromPart(p) !== undefined ||
      activityDurationFromPart(p) !== undefined ||
      partType(p) === "step-start"
    ) {
      flushRun();
      return;
    }
    if (partType(p) === "text" && !isBodyTextPart(p)) {
      flushRun();
      return;
    }
    if (isReadFilePart(p)) {
      if (!run) run = { parts: [], startIdx: i };
      run.parts.push(p);
      return;
    }
    flushRun();
    out.push({ kind: "single", part: p, idx: i, key: partKey(p, i) });
  });
  flushRun();
  return out;
}

function hasVisibleAssistantOutput(parts: readonly AnyPart[]): boolean {
  return parts.some(
    (part) => isVisibleActivityPart(part) || isActivityBoundary(part),
  );
}

function isToolPart(part: AnyPart): boolean {
  const type = partType(part);
  return type === "dynamic-tool" || type.startsWith("tool-");
}

function isSubagentToolPart(part: AnyPart): boolean {
  if (!isToolPart(part)) return false;
  return (
    partType(part) === "tool-run_subagent" ||
    (partType(part) === "dynamic-tool" &&
      (part as { toolName?: string }).toolName === "run_subagent")
  );
}

function isBodyTextPart(part: AnyPart): boolean {
  return (
    partType(part) === "text" &&
    ((part as { text?: string }).text?.trim().length ?? 0) > 0
  );
}

function isVisibleActivityPart(part: AnyPart): boolean {
  return partType(part) === "reasoning" || isToolPart(part);
}

function isActivityBoundary(part: AnyPart): boolean {
  return isBodyTextPart(part) || isSubagentToolPart(part);
}

const ACTIVITY_TOOL_LABELS: Record<string, () => string> = {
  read_file: () => i18n.t("ai:chat.subagent.actions.read"),
  find_files: () => i18n.t("ai:chat.subagent.actions.find"),
  write_file: () => i18n.t("ai:chat.subagent.actions.write"),
  apply_patch: () => i18n.t("ai:chat.subagent.actions.edit"),
  file_operation: () => i18n.t("ai:chat.subagent.actions.manage"),
  shell_exec: () => i18n.t("ai:chat.subagent.actions.run"),
  shell_list: () => i18n.t("ai:chat.subagent.actions.listProcesses"),
  grep: () => i18n.t("ai:chat.subagent.actions.search"),
  get_terminal_output: () => i18n.t("ai:chat.activity.activeTerminal"),
};

/** 仅为展示压缩摘要；参数未提供可读内容时不生成标题，不改写工具输入。 */
export function activityHeadline(
  part: AnyPart,
  thinkingText: string,
): ChatActivityHeadline {
  if (partType(part) === "reasoning") {
    return { kind: "thinking", key: "thinking", text: thinkingText };
  }
  const toolName =
    partType(part) === "dynamic-tool"
      ? ((part as { toolName?: string }).toolName ?? "tool")
      : partType(part).replace(/^tool-/, "");
  const externalLabel = externalAgentActivityLabel(
    toolName,
    (part as { input?: unknown }).input,
  );
  if (externalLabel) {
    return {
      kind: "tool",
      key: toolCallIdFromPart(part) || toolName,
      text: compactActivityText(externalLabel),
    };
  }
  let label = ACTIVITY_TOOL_LABELS[toolName]?.() ?? toolName;
  if (toolName === "file_operation") {
    const operations: Record<string, string> = {
      move: i18n.t("ai:chat.activity.fileOperation.move"),
      copy: i18n.t("ai:chat.activity.fileOperation.copy"),
      delete: i18n.t("ai:chat.activity.fileOperation.delete"),
      create_directory: i18n.t(
        "ai:chat.activity.fileOperation.createDirectory",
      ),
    };
    label =
      operations[
        objectStringValue((part as { input?: unknown }).input, "operation") ??
          ""
      ] ?? label;
  }
  const summary = activityToolSummary(
    toolName,
    (part as { input?: unknown }).input,
  );
  const needsSummary = [
    "read_file",
    "write_file",
    "file_operation",
    "find_files",
    "apply_patch",
    "shell_exec",
    "shell_process",
    "grep",
  ].includes(toolName);
  const defaultFind =
    toolName === "find_files" &&
    (part as { state?: string }).state !== "input-streaming";
  if (needsSummary && !summary?.trim() && !defaultFind) {
    return null;
  }
  const actionOnly =
    toolName === "shell_process" || toolName === "get_terminal_output";
  return {
    kind: "tool",
    key: toolCallIdFromPart(part) || toolName,
    text: compactActivityText(summary || (defaultFind ? "." : label)),
    ...(!actionOnly && (summary || defaultFind) ? { action: label } : {}),
  };
}

function compactActivityText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  return characters.length > 160
    ? `${characters.slice(0, 159).join("")}…`
    : normalized;
}

function activityToolSummary(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const text = (key: string) =>
    typeof value[key] === "string" ? (value[key] as string) : null;

  switch (toolName) {
    case "read_file":
    case "write_file":
      return text("path");
    case "file_operation": {
      const path = text("path");
      if (!path) return null;
      const destination = text("destination");
      return `${path}${destination ? ` → ${destination}` : ""}`;
    }
    case "find_files":
      return [text("glob"), text("path")].filter(Boolean).join(" · ") || null;
    case "apply_patch": {
      const files = Array.isArray(value.files) ? value.files : [];
      const paths = files
        .map((file) => objectStringValue(file, "path"))
        .filter(Boolean);
      return paths.join(", ") || null;
    }
    case "shell_exec":
      return text("command");
    case "shell_process": {
      const actions: Record<string, string> = {
        poll: i18n.t("ai:chat.activity.process.poll"),
        write: i18n.t("ai:chat.activity.process.write"),
        close_stdin: i18n.t("ai:chat.activity.process.closeStdin"),
        terminate: i18n.t("ai:chat.activity.process.terminate"),
      };
      return actions[text("action") ?? ""] ?? null;
    }
    case "get_terminal_output":
      return i18n.t("ai:chat.activity.activeTerminal");
    case "grep":
      return text("pattern") ?? text("query");
    default:
      return null;
  }
}

/** 判断推理分段之后是否已经出现正文、工具或下一段推理。 */
function hasVisiblePartAfter(
  parts: readonly AnyPart[],
  index: number,
): boolean {
  for (let nextIndex = index + 1; nextIndex < parts.length; nextIndex += 1) {
    const part = parts[nextIndex];
    const type = partType(part);
    if (type === "reasoning") return true;
    if (type === "text") {
      if (isBodyTextPart(part)) return true;
      continue;
    }
    if (type === "dynamic-tool" || type.startsWith("tool-")) return true;
  }
  return false;
}

function externalAgentActivityLabel(
  toolName: string,
  input: unknown,
): string | null {
  if (!toolName.startsWith("external_agent_")) return null;
  const agentId = objectStringValue(input, "agentId") ?? "Agent";
  switch (toolName) {
    case "external_agent_start":
      return i18n.t("ai:chat.externalAgent.starting", {
        agent: displayAgent(agentId),
      });
    case "external_agent_file_change":
      return i18n.t("ai:chat.externalAgent.fileChange");
    case "external_agent_thinking":
      return i18n.t("ai:chat.externalAgent.thinking");
    case "external_agent_web_search":
      return i18n.t("ai:chat.externalAgent.webSearch");
    case "external_agent_tool":
      return i18n.t("ai:chat.externalAgent.tool", {
        tool: objectStringValue(input, "tool") ?? "tool",
      });
    default:
      return null;
  }
}

function subagentResultForPart(
  part: AnyPart,
  resultsByTaskId: ReadonlyMap<string, SubagentResultView> | undefined,
): SubagentResultView | undefined {
  const taskId = objectStringValue(
    "output" in part ? part.output : undefined,
    "taskId",
  );
  return taskId ? resultsByTaskId?.get(taskId) : undefined;
}

function toolCallIdFromPart(part: AnyPart): string {
  return "toolCallId" in part && typeof part.toolCallId === "string"
    ? part.toolCallId
    : "";
}

function objectStringValue(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function readPathFromPart(p: AnyPart): string | null {
  const input = (p as { input?: { path?: unknown } }).input;
  const path = input?.path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

const ReadGroup = memo(function ReadGroup({ parts }: { parts: AnyPart[] }) {
  const { t } = useTranslation("ai");
  const paths = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of parts) {
      const path = readPathFromPart(p);
      if (!path) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
    return out;
  }, [parts]);
  const count = paths.length || parts.length;
  const preview = paths.map(basename).join(", ");

  return (
    <Collapsible className="group/read overflow-hidden rounded-md border border-border/50 bg-card/50">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 px-2 py-[3px] text-left text-[12px] leading-4",
          "transition-colors hover:bg-interactive-hover",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={11}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            "group-data-[state=open]/read:rotate-90",
          )}
        />
        <HugeiconsIcon
          icon={File01Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">
          {t("chat.read")}
        </span>
        <span className="shrink-0 text-[12px] text-muted-foreground">
          {t("chat.readFiles", { count })}
        </span>
        {paths.length > 0 ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground group-data-[state=open]/read:invisible">
            · {preview}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="terax-collapsible-content border-t border-border/30">
        <ul className="flex flex-col gap-0.5 px-2 py-1.5">
          {paths.map((path) => (
            <li
              key={path}
              className="flex items-center gap-1.5 font-mono text-[12px] text-muted-foreground"
            >
              <HugeiconsIcon
                icon={File01Icon}
                size={10}
                strokeWidth={1.75}
                className="shrink-0 opacity-60"
              />
              <span className="truncate text-foreground">{basename(path)}</span>
              <span className="truncate text-muted-foreground">{path}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
});

const PartAppear = memo(function PartAppear({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-control ease-emphasized">
      {children}
    </div>
  );
});

const ReadRow = memo(function ReadRow({ part }: { part: AnyPart }) {
  const { t } = useTranslation("ai");
  const path = readPathFromPart(part);
  const state = (part as { state?: string }).state ?? "";
  const isError = state === "output-error";
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-[3px] text-[12px] leading-4">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isError
            ? "bg-destructive"
            : "border border-muted-foreground/40 bg-transparent",
        )}
      />
      <HugeiconsIcon
        icon={File01Icon}
        size={13}
        strokeWidth={1.75}
        className="shrink-0 text-muted-foreground"
      />
      <span className="shrink-0 font-medium text-foreground">
        {t("chat.read")}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
        {path ?? ""}
      </span>
    </div>
  );
});

const RenderedPart = memo(function RenderedPart({
  sessionId,
  part,
  streaming,
  reasoningStreaming,
  autoCollapseReasoning,
  reasoningDurationMs,
  persistedSubagent,
  subagentResult,
}: {
  sessionId: string;
  part: AnyPart;
  streaming: boolean;
  reasoningStreaming: boolean;
  autoCollapseReasoning: boolean;
  reasoningDurationMs?: number;
  persistedSubagent?: SubagentDisplaySnapshot;
  subagentResult?: SubagentResultView;
}) {
  if (part.type === "text") {
    return (
      <ChatMessageResponse
        className="[&>*:last-child]:mb-0!"
        streaming={streaming}
      >
        {(part as unknown as { text: string }).text}
      </ChatMessageResponse>
    );
  }

  if (part.type === "reasoning") {
    return (
      <ChatReasoningPart
        text={(part as unknown as { text: string }).text}
        durationMs={reasoningDurationMs}
        isStreaming={reasoningStreaming}
        autoCollapse={autoCollapseReasoning}
      />
    );
  }

  if (
    part.type === "dynamic-tool" ||
    (typeof part.type === "string" && part.type.startsWith("tool-"))
  ) {
    const toolPart = part as unknown as AnyToolPart;
    const toolName =
      toolPart.type === "dynamic-tool"
        ? toolPart.toolName
        : toolPart.type.replace(/^tool-/, "");
    if (toolName === "run_subagent") {
      return (
        <LiveSubagentCard
          sessionId={sessionId}
          part={toolPart}
          persistedDisplay={persistedSubagent}
          backgroundResult={subagentResult}
        />
      );
    }
    return <RenderedTool part={part as unknown as AnyToolPart} />;
  }

  return null;
});

const LiveSubagentCard = memo(function LiveSubagentCard({
  sessionId,
  part,
  persistedDisplay,
  backgroundResult,
}: {
  sessionId: string;
  part: AnyToolPart;
  persistedDisplay?: SubagentDisplaySnapshot;
  backgroundResult?: SubagentResultView;
}) {
  const liveDisplay = useChatStore(
    (state) => state.subagentDisplaysBySession[sessionId]?.[part.toolCallId],
  );
  return (
    <SubagentCard
      sessionId={sessionId}
      part={part}
      display={liveDisplay ?? persistedDisplay}
      backgroundResult={backgroundResult}
    />
  );
});

/** 投影工具的结构化业务错误，并保留用户拒绝的独立状态。 */
export function resolveToolDisplay(part: AnyToolPart): {
  state: AnyToolPart["state"];
  errorText: string | undefined;
} {
  if (part.state === "output-denied") {
    return {
      state: "output-denied",
      errorText: undefined,
    };
  }
  const output = "output" in part ? part.output : undefined;
  const structuredError =
    output && typeof output === "object"
      ? (output as Record<string, unknown>).error
      : undefined;
  const errorText =
    "errorText" in part && typeof part.errorText === "string"
      ? part.errorText
      : typeof structuredError === "string" && structuredError.length > 0
        ? structuredError
        : undefined;
  return {
    state: errorText ? "output-error" : part.state,
    errorText,
  };
}

/** 渲染工具摘要，并将拒绝原因作为非错误终态展示。 */
const RenderedTool = memo(function RenderedTool({
  part,
}: {
  part: AnyToolPart;
}) {
  const toolName =
    part.type === "dynamic-tool"
      ? part.toolName
      : part.type.replace(/^tool-/, "");
  const externalLabel = externalAgentActivityLabel(toolName, part.input);
  const display = resolveToolDisplay(part);
  const denied = part.state === "output-denied";
  const tool =
    toolName === "write_file" || toolName === "apply_patch" ? (
      <FileEditTool
        toolName={toolName}
        toolCallId={part.toolCallId}
        input={part.input}
        state={display.state}
        errorText={display.errorText}
      />
    ) : (
      <Tool
        className="ai-tool-details [&_*]:text-[12px]! [&>button]:py-[3px] [&>button]:leading-4"
        toolName={externalLabel ?? toolName}
        state={display.state}
        input={externalLabel ? undefined : part.input}
        output={"output" in part ? part.output : undefined}
        errorText={display.errorText}
      />
    );

  if (!denied) return tool;

  return (
    <div className="space-y-0.5">
      {tool}
      <div className="pl-7 text-[11px] text-orange-600 dark:text-orange-400">
        {i18n.t("ai:chat.toolDenied")}
      </div>
    </div>
  );
});

/** 将工具详情中的 Shift 加滚轮转换为横向滚动，监听器必须以 non-passive 注册。 */
function handleToolDetailsWheel(event: WheelEvent) {
  const delta = event.deltaX || event.deltaY;
  if (!event.shiftKey || delta === 0) return;

  const target = event.target;
  if (!(target instanceof Element)) return;

  const scrollArea = target.closest<HTMLElement>(
    ".ai-tool-details .overflow-auto, .ai-tool-details [data-slot='collapsible-content'] > div",
  );
  if (!scrollArea || scrollArea.scrollWidth <= scrollArea.clientWidth) return;

  event.preventDefault();
  scrollArea.scrollLeft += delta;
}

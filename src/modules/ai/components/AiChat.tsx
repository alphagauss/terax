/**
 * 本文件实现 AI 会话消息列表、滚动记忆以及正文、推理和工具分段渲染。
 * 工具详情在会话层统一提供可见滚动条和 Shift 加滚轮的横向滚动。
 * 内部结果、reasoning 耗时和 Subagent 展示事件不参与普通分组。
 * 历史消息和已完成工具保持稳定且默认折叠。
 */

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
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Tool } from "@/components/ai-elements/tool";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import i18n from "@/i18n";
import { cn } from "@/lib/utils";
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
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { StickToBottomContext } from "use-stick-to-bottom";
import {
  isSubagentDisplayDataPart,
  type SubagentDisplaySnapshot,
} from "../agents/subagentDisplay";
import { isSubagentResultDataPart } from "../agents/subagentRuntime";
import { CHAT_SCROLL_SPRING } from "../lib/chatScroll";
import { formatMessageTimestamp } from "../lib/messageTimestamp";
import { reasoningDurationFromPart } from "../lib/sessionMessages";
import { SLASH_COMMANDS, TERAX_CMD_RE } from "../lib/slashCommands";
import { sendMessage } from "../store/chatRuntime";
import { getAgentMetaForSession, useChatStore } from "../store/chatStore";
import { useSessionAttentionStore } from "../store/sessionAttentionStore";
import { AiChatScrollControls } from "./AiChatScrollControls";
import { SubagentCard, type SubagentResultView } from "./SubagentCard";

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
function useConversationScrollMemory(sessionId: string, visible: boolean) {
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
      !visible ||
      !revealLatest ||
      !useSessionAttentionStore.getState().takeRevealLatest(sessionId)
    ) {
      return;
    }
    conversationScrollPositions.delete(sessionId);
    window.requestAnimationFrame(() => {
      void contextRef.current?.scrollToBottom({
        animation: "instant",
        ignoreEscapes: true,
      });
    });
  }, [revealLatest, sessionId, visible]);

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

function CommandSnippet({ name }: { name: string }) {
  const meta = SLASH_COMMANDS[name];
  if (!meta) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-2 py-1 font-mono text-[11px]">
        /{name}
      </div>
    );
  }
  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-border/50 bg-muted/40 px-2 py-1">
      <HugeiconsIcon
        icon={meta.icon}
        size={12}
        strokeWidth={1.75}
        className="shrink-0 text-foreground"
      />
      <span className="font-mono text-[11px] text-foreground">
        {meta.invocation}
      </span>
      <span className="truncate text-[11px] text-muted-foreground">
        {meta.label}
      </span>
    </div>
  );
}

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

type ContextChip =
  | { kind: "selection"; source: "terminal" | "editor"; lines: number }
  | { kind: "file"; name: string; lines: number }
  | { kind: "snippet"; name: string };

const SELECTION_RE =
  /<selection\s+source="(terminal|editor)">\n?([\s\S]*?)\n?<\/selection>/g;
const FILE_RE = /<file\s+name="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/file>/g;
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
  out = out.replace(FILE_RE, (_m, name: string, body: string) => {
    chips.push({ kind: "file", name, lines: countLines(body) });
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
  if (c.kind === "file") {
    return <HugeiconsIcon icon={File01Icon} size={10} strokeWidth={1.75} />;
  }
  return <HugeiconsIcon icon={HashtagIcon} size={10} strokeWidth={1.75} />;
}

function chipLabel(c: ContextChip): string {
  if (c.kind === "selection") {
    return c.source === "editor"
      ? i18n.t("ai:chat.editorSelection")
      : i18n.t("ai:chat.terminalSelection");
  }
  if (c.kind === "file") return c.name;
  return `#${c.name}`;
}
type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

type Props = {
  sessionId: string;
  visible: boolean;
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  clearError: () => void;
};

/**
 * AI 会话消息视图。
 *
 * 负责恢复每个会话的滚动位置、渲染流式末尾消息，并在通知导航时等待面板可见后前往最新结果。
 */
export function AiChatView({
  sessionId,
  visible,
  messages,
  status,
  error,
  clearError,
}: Props) {
  const { t } = useTranslation("ai");
  const scrollMemory = useConversationScrollMemory(sessionId, visible);
  const isBusy = status === "submitted" || status === "streaming";
  const lastMessage = messages[messages.length - 1];
  const showSpinner = isBusy && lastMessage?.role === "user";
  const streamingMessageId =
    status === "streaming" && lastMessage?.role === "assistant"
      ? lastMessage.id
      : null;
  const meta = useChatStore((state) =>
    getAgentMetaForSession(state, sessionId),
  );
  const { step, hitStepCap, compactionNotice } = meta;
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

  if (messages.length === 0) {
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
      <ConversationContent
        className="gap-5 p-3"
        scrollClassName="app-scrollbar [scrollbar-gutter:stable]"
      >
        <div ref={setToolDetailsWheelScope} className="contents">
          {messages.map((m) => (
            <RenderedMessage
              key={m.id}
              sessionId={sessionId}
              message={m}
              streaming={m.id === streamingMessageId}
            />
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
        {showSpinner && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner />
            <span className="truncate">{step ?? t("chat.thinking")}</span>
          </div>
        )}
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
            <div className="mt-0.5 leading-relaxed">{error.message}</div>
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
  // AI SDK 只会继续修改末尾 part；更早的正文和推理块已经终结，
  // 不应因后续工具调用继续显示流式状态。
  const streamingPartIdx = streaming ? message.parts.length - 1 : -1;
  const groups = useMemo(
    () =>
      message.role === "user"
        ? []
        : buildPartGroups(message.parts as AnyPart[]),
    [message.parts, message.role],
  );
  const timestamp = useMessageTimestamp(message);
  const copyText = useMemo(() => messageTextForCopy(message), [message]);
  const subagentParts = useMemo(
    () => collectSubagentParts(message.parts as AnyPart[]),
    [message.parts],
  );
  if (message.role === "user") {
    const rawText = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");

    const cmdMatch = rawText.match(TERAX_CMD_RE);
    const commandName = cmdMatch?.[1] ?? null;
    const withoutCmd = cmdMatch ? rawText.slice(cmdMatch[0].length) : rawText;
    const stripped = stripUserContextBlocks(withoutCmd);

    return (
      <Message
        from="user"
        data-conversation-message-id={message.id}
        className="group/message"
      >
        <MessageContent>
          {commandName ? <CommandSnippet name={commandName} /> : null}
          {stripped.chips.length > 0 ? (
            <ContextChips chips={stripped.chips} />
          ) : null}
          {stripped.text ? (
            <p className="whitespace-pre-wrap wrap-break-word">
              {stripped.text}
            </p>
          ) : null}
        </MessageContent>
        <MessageMeta timestamp={timestamp} copyText={copyText} />
      </Message>
    );
  }

  return (
    <Message
      from={message.role}
      data-conversation-message-id={message.id}
      className="group/message"
    >
      <MessageContent>
        <div className="flex flex-col gap-1">
          {groups.map((g) => {
            if (g.kind === "reads") {
              return (
                <PartAppear key={`${message.id}-${g.key}`}>
                  <ReadGroup parts={g.parts} />
                </PartAppear>
              );
            }
            const isReadSingle =
              partType(g.part) === "tool-read_file" &&
              ((g.part as { state?: string }).state ?? "") !==
                "approval-requested";
            if (isReadSingle) {
              return (
                <PartAppear key={`${message.id}-${g.key}`}>
                  <ReadRow part={g.part} />
                </PartAppear>
              );
            }
            return (
              <PartAppear key={`${message.id}-${g.key}`}>
                <RenderedPart
                  sessionId={sessionId}
                  part={g.part}
                  streaming={g.idx === streamingPartIdx}
                  reasoningDurationMs={reasoningDurationFromPart(
                    message.parts[g.idx + 1],
                  )}
                  persistedSubagent={subagentParts.displaysByToolCallId.get(
                    toolCallIdFromPart(g.part),
                  )}
                  subagentResult={subagentResultForPart(
                    g.part,
                    subagentParts.resultsByTaskId,
                  )}
                />
              </PartAppear>
            );
          })}
        </div>
      </MessageContent>
      <MessageMeta timestamp={timestamp} copyText={copyText} />
    </Message>
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
  const text = message.parts
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
  if (message.role !== "user") return text;
  const withoutCommand = text.replace(TERAX_CMD_RE, "");
  return stripUserContextBlocks(withoutCommand).text;
}

/** 消息底部的时间与复制操作，仅在消息悬停或键盘聚焦时显示。 */
const MessageMeta = memo(function MessageMeta({
  timestamp,
  copyText,
}: {
  timestamp: number;
  copyText: string;
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
    </MessageActions>
  );
});

type Group =
  | { kind: "single"; part: AnyPart; idx: number; key: string }
  | { kind: "reads"; parts: AnyPart[]; key: string };

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

function buildPartGroups(parts: AnyPart[]): Group[] {
  const out: Group[] = [];
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
  parts.forEach((p, i) => {
    if (reasoningDurationFromPart(p) !== undefined) {
      flushRun();
      return;
    }
    if (
      partType(p) === "data-subagent-result" ||
      partType(p) === "data-subagent-display"
    ) {
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

function collectSubagentParts(parts: readonly AnyPart[]): {
  displaysByToolCallId: Map<string, SubagentDisplaySnapshot>;
  resultsByTaskId: Map<string, SubagentResultView>;
} {
  const displaysByToolCallId = new Map<string, SubagentDisplaySnapshot>();
  const resultsByTaskId = new Map<string, SubagentResultView>();
  for (const part of parts) {
    const value: unknown = part;
    if (isSubagentDisplayDataPart(value)) {
      displaysByToolCallId.set(
        value.data.snapshot.toolCallId,
        value.data.snapshot,
      );
      continue;
    }
    if (!isSubagentResultDataPart(value)) continue;
    for (const result of value.data.event.results) {
      resultsByTaskId.set(result.taskId, {
        status: result.status,
        ...(result.result === undefined ? {} : { result: result.result }),
        ...(result.error === undefined ? {} : { error: result.error }),
      });
    }
  }
  return { displaysByToolCallId, resultsByTaskId };
}

function subagentResultForPart(
  part: AnyPart,
  resultsByTaskId: ReadonlyMap<string, SubagentResultView>,
): SubagentResultView | undefined {
  const taskId = objectStringValue(
    "output" in part ? part.output : undefined,
    "taskId",
  );
  return taskId ? resultsByTaskId.get(taskId) : undefined;
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
          "flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] leading-4",
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
    <div className="flex items-center gap-2 rounded-md px-2 py-1 text-[12px] leading-4">
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
  reasoningDurationMs,
  persistedSubagent,
  subagentResult,
}: {
  sessionId: string;
  part: AnyPart;
  streaming: boolean;
  reasoningDurationMs?: number;
  persistedSubagent?: SubagentDisplaySnapshot;
  subagentResult?: SubagentResultView;
}) {
  if (part.type === "text") {
    return (
      <MessageResponse streaming={streaming}>
        {(part as unknown as { text: string }).text}
      </MessageResponse>
    );
  }

  if (part.type === "reasoning") {
    const duration =
      reasoningDurationMs === undefined
        ? undefined
        : Math.max(1, Math.ceil(reasoningDurationMs / 1000));
    return (
      <Reasoning isStreaming={streaming} duration={duration}>
        <ReasoningTrigger
          data-ai-reasoning-trigger
          className="text-[12px] leading-4"
        />
        <ReasoningContent className="[&_*]:text-[12px]!">
          {(part as unknown as { text: string }).text}
        </ReasoningContent>
      </Reasoning>
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
      part={part}
      display={liveDisplay ?? persistedDisplay}
      backgroundResult={backgroundResult}
    />
  );
});

const RenderedTool = memo(function RenderedTool({
  part,
}: {
  part: AnyToolPart;
}) {
  const toolName =
    part.type === "dynamic-tool"
      ? part.toolName
      : part.type.replace(/^tool-/, "");

  return (
    <Tool
      className="ai-tool-details [&_*]:text-[12px]! [&>button]:py-1 [&>button]:leading-4"
      toolName={toolName}
      state={part.state}
      input={part.input}
      output={"output" in part ? part.output : undefined}
      errorText={"errorText" in part ? part.errorText : undefined}
    />
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

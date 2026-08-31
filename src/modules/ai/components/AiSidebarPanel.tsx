/**
 * 本文件实现 AI 侧边栏的会话外壳、上下文指标和空状态入口。
 * 流式消息更新在此合并提交，避免头部统计和聊天正文按每个 delta 重渲染。
 */

import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextTrigger,
} from "@/components/ai-elements/context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { currentWorkspaceBootstrap } from "@/modules/workspace-process";
import { type UIMessage, useChat } from "@ai-sdk/react";
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  Delete02Icon,
  FilterIcon,
  PencilEdit02Icon,
  TerminalIcon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  estimateCost,
  getModel,
  getModelContextLimit,
  type ModelId,
} from "../config";
import {
  estimateUiMessageTokens,
  STREAM_RENDER_INTERVAL_MS,
} from "../lib/chatRendering";
import { MAIN_AGENT, MAIN_AGENT_ID } from "../lib/agents";
import { formatMessageTimestamp } from "../lib/messageTimestamp";
import type { SessionMeta } from "../lib/sessions";
import { getOrCreateChat } from "../store/chatRuntime";
import { useAgentsStore } from "../store/agentsStore";
import { getAgentMetaForSession, useChatStore } from "../store/chatStore";
import {
  type SessionAttention,
  useSessionAttentionStore,
} from "../store/sessionAttentionStore";
import { AiChatView } from "./AiChat";
import { AGENT_ICONS } from "./AgentSwitcher";
import { AiInputBarConnect } from "./AiInputBar";
import { AiSidebarComposer } from "./AiSidebarComposer";
import { TodoStrip } from "./TodoStrip";

const SUGGESTIONS = [
  {
    translationKey: "explainError",
    icon: AlertCircleIcon,
  },
  {
    translationKey: "generateCommand",
    icon: TerminalIcon,
  },
  {
    translationKey: "summarizeBuffer",
    icon: FilterIcon,
  },
] as const;

/**
 * AI 侧边栏主面板。
 *
 * 负责连接当前会话、聊天区域和输入区，关闭侧边栏不会主动终止正在运行的会话。
 */
export function AiSidebarPanel({
  hasComposer,
  visible,
}: {
  hasComposer: boolean;
  visible: boolean;
}) {
  const sessionId = useChatStore((s) => s.activeSessionId);
  const revision = useChatStore((s) => s.activeSessionRevision);
  const readOnly = useChatStore((s) => {
    const session = s.sessions.find((item) => item.id === s.activeSessionId);
    return (
      session !== undefined &&
      session.environmentKey !== currentWorkspaceBootstrap().environmentKey
    );
  });
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-sidebar text-[12px]">
      {sessionId ? (
        <Body
          key={`${sessionId}:${revision}`}
          sessionId={sessionId}
          readOnly={readOnly}
          visible={visible}
        />
      ) : (
        <EmptyShell />
      )}
      {hasComposer ? (
        <AiSidebarComposer />
      ) : (
        <AiInputBarConnect onAdd={() => void openSettingsWindow("models")} />
      )}
    </div>
  );
}

function Body({
  sessionId,
  readOnly,
  visible,
}: {
  sessionId: string;
  readOnly: boolean;
  visible: boolean;
}) {
  const focusInput = useChatStore((s) => s.focusInput);
  const step = useChatStore(
    (state) => getAgentMetaForSession(state, sessionId).step,
  );

  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const helpers = useChat<UIMessage>({
    chat,
    experimental_throttle: STREAM_RENDER_INTERVAL_MS,
  });
  const isBusy =
    helpers.status === "submitted" || helpers.status === "streaming";

  return (
    <>
      <Header
        sessionId={sessionId}
        step={step}
        isBusy={isBusy}
        messages={helpers.messages}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        {helpers.messages.length === 0 ? (
          <EmptyState onPick={focusInput} disabled={readOnly} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col [&_.text-sm]:text-[12px] [&_p]:leading-relaxed">
            <AiChatView
              sessionId={sessionId}
              visible={visible}
              messages={helpers.messages}
              status={helpers.status}
              error={helpers.error}
              clearError={helpers.clearError}
            />
          </div>
        )}
      </div>

      <TodoStrip sessionId={sessionId} />
    </>
  );
}

function EmptyShell() {
  const { t } = useTranslation("ai");
  return (
    <>
      <Header sessionId={null} step={null} isBusy={false} />
      <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
        {t("miniWindow.loadingSessions")}
      </div>
    </>
  );
}

function Header({
  sessionId,
  step,
  isBusy,
  messages,
}: {
  sessionId: string | null;
  step: string | null;
  isBusy: boolean;
  messages?: UIMessage[];
}) {
  const { t } = useTranslation("ai");
  const newSession = useChatStore((s) => s.newSession);

  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <SessionPicker />
        {messages !== undefined ? (
          <ContextIndicator
            sessionId={sessionId}
            isBusy={isBusy}
            messages={messages}
          />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {isBusy ? (
          <span className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
            <Spinner className="size-2.5" />
            <span className="max-w-32 truncate">
              {step ?? t("miniWindow.thinking")}
            </span>
          </span>
        ) : null}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => void openSettingsWindow("models")}
          className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t("miniWindow.aiSettings")}
          title={t("miniWindow.aiSettings")}
        >
          <HugeiconsIcon icon={Wrench01Icon} size={15} strokeWidth={1.75} />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => newSession()}
          className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t("miniWindow.newSession")}
          title={t("miniWindow.newSession")}
        >
          <HugeiconsIcon icon={PencilEdit02Icon} size={15} strokeWidth={1.75} />
        </Button>
      </div>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function ContextIndicator({
  sessionId,
  isBusy,
  messages,
}: {
  sessionId: string | null;
  isBusy: boolean;
  messages: UIMessage[];
}) {
  const { t } = useTranslation("ai");
  const modelId = useChatStore((s) => s.selectedModelId);
  const meta = useChatStore((state) =>
    getAgentMetaForSession(state, sessionId),
  );
  const {
    tokens,
    lastInputTokens: lastInput,
    lastCachedTokens: lastCached,
  } = meta;
  const settledEstimateRef = useRef(0);
  const shouldEstimate = !isBusy && lastInput <= 0;
  const estimated = useMemo(() => {
    if (!shouldEstimate) {
      return settledEstimateRef.current;
    }
    const nextEstimate = estimateUiMessageTokens(messages);
    settledEstimateRef.current = nextEstimate;
    return nextEstimate;
  }, [messages, shouldEstimate]);
  const used = lastInput > 0 ? lastInput : estimated;
  const reported = tokens.inputTokens + tokens.outputTokens;
  const openaiCompatibleContextLimit = usePreferencesStore(
    (s) => s.openaiCompatibleContextLimit,
  );
  const max = getModelContextLimit(modelId, openaiCompatibleContextLimit);
  const modelLabel = useMemo(() => {
    try {
      return getModel(modelId as ModelId).label;
    } catch {
      return modelId;
    }
  }, [modelId]);
  const cost = estimateCost(modelId, tokens);
  const cacheRate =
    tokens.inputTokens > 0
      ? Math.round((tokens.cachedInputTokens / tokens.inputTokens) * 100)
      : 0;

  return (
    <Context usedTokens={used} maxTokens={max}>
      <ContextTrigger className="h-6 gap-1 px-0 text-[10.5px]" />
      <ContextContent className="w-64 text-[11px]">
        <ContextContentHeader />
        <ContextContentBody>
          <div className="flex items-center justify-between text-muted-foreground">
            <span>{t("miniWindow.context.model")}</span>
            <span className="font-mono text-foreground">{modelLabel}</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-muted-foreground">
            <span>
              {lastInput > 0
                ? t("miniWindow.context.lastRequest")
                : t("miniWindow.context.estimatedContext")}
            </span>
            <span className="font-mono text-foreground">
              {formatTokens(used)}
            </span>
          </div>
          {lastCached > 0 && (
            <div className="flex items-center justify-between text-muted-foreground">
              <span>{t("miniWindow.context.ofWhichCached")}</span>
              <span className="font-mono text-foreground">
                {formatTokens(lastCached)}
              </span>
            </div>
          )}
          {reported > 0 && (
            <>
              <div className="mt-1.5 flex items-center justify-between text-muted-foreground">
                <span>{t("miniWindow.context.sessionInput")}</span>
                <span className="font-mono text-foreground">
                  {formatTokens(tokens.inputTokens)}
                </span>
              </div>
              <div className="flex items-center justify-between text-muted-foreground">
                <span>{t("miniWindow.context.sessionOutput")}</span>
                <span className="font-mono text-foreground">
                  {formatTokens(tokens.outputTokens)}
                </span>
              </div>
              {tokens.cachedInputTokens > 0 && (
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>{t("miniWindow.context.cacheHit")}</span>
                  <span className="font-mono text-foreground">
                    {cacheRate}%
                  </span>
                </div>
              )}
              {cost != null && (
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>{t("miniWindow.context.sessionCost")}</span>
                  <span className="font-mono text-foreground">
                    ${cost.toFixed(cost < 0.01 ? 4 : cost < 1 ? 3 : 2)}
                  </span>
                </div>
              )}
            </>
          )}
          <div className="flex items-center justify-between text-muted-foreground">
            <span>{t("miniWindow.context.window")}</span>
            <span className="font-mono text-foreground">
              {formatTokens(max)}
            </span>
          </div>
        </ContextContentBody>
        <ContextContentFooter>
          <span className="text-[10px] italic text-muted-foreground">
            {lastInput > 0
              ? t("miniWindow.context.footerLastRequest")
              : t("miniWindow.context.footerApprox")}
          </span>
        </ContextContentFooter>
      </ContextContent>
    </Context>
  );
}

function SessionPicker() {
  const { t } = useTranslation("ai");
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeSessionId);
  const runLocks = useChatStore((s) => s.runLockSessionIds);
  const attentionBySession = useSessionAttentionStore((s) => s.bySession);
  const switchSession = useChatStore((s) => s.switchSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const agentFilter = useChatStore((state) => state.sessionAgentFilter);
  const setAgentFilter = useChatStore((state) => state.setSessionAgentFilter);
  const customAgents = useAgentsStore((state) => state.customAgents);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const isDraft = activeId != null && !active;
  const agents = useMemo(
    () => [{ ...MAIN_AGENT, tools: [...MAIN_AGENT.tools] }, ...customAgents],
    [customAgents],
  );
  useEffect(() => {
    if (
      agentFilter !== null &&
      !agents.some((agent) => agent.id === agentFilter)
    ) {
      setAgentFilter(null);
    }
  }, [agentFilter, agents, setAgentFilter]);
  const sorted = sessions
    .filter(
      (session) => agentFilter === null || session.agentId === agentFilter,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (!active && !isDraft) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex min-w-0 max-w-48 items-center gap-1 rounded-md px-1.5 py-1",
            "text-[11px] text-foreground outline-none transition-colors",
            "hover:bg-accent hover:text-foreground",
            "focus-visible:outline-none",
          )}
          title={t("miniWindow.switchSession")}
        >
          <span className="truncate">
            {active?.title || t("miniWindow.newChat")}
          </span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={10}
            strokeWidth={2}
            className="opacity-70"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2">
            <HugeiconsIcon icon={FilterIcon} size={12} strokeWidth={1.75} />
            <span className="flex-1">{t("miniWindow.agentFilter.label")}</span>
            <span className="max-w-24 truncate text-[10px] text-muted-foreground">
              {agentFilter === null
                ? t("miniWindow.agentFilter.all")
                : agents.find((agent) => agent.id === agentFilter)?.name}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-52">
            <DropdownMenuRadioGroup
              value={agentFilter ?? "all"}
              onValueChange={(value) =>
                setAgentFilter(value === "all" ? null : value)
              }
            >
              <DropdownMenuRadioItem value="all">
                <span className="flex flex-1 justify-between gap-4">
                  <span>{t("miniWindow.agentFilter.all")}</span>
                  <span className="text-muted-foreground">
                    {sessions.length}
                  </span>
                </span>
              </DropdownMenuRadioItem>
              {agents.map((agent) => (
                <DropdownMenuRadioItem key={agent.id} value={agent.id}>
                  <span className="flex flex-1 justify-between gap-4">
                    <span className="truncate">{agentDisplayLabel(agent)}</span>
                    <span className="text-muted-foreground">
                      {
                        sessions.filter(
                          (session) => session.agentId === agent.id,
                        ).length
                      }
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        {sorted.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            agentName={
              agents.find((agent) => agent.id === s.agentId)?.name ??
              s.agentName
            }
            agentIcon={
              agents.find((agent) => agent.id === s.agentId)?.icon ??
              s.agentIcon
            }
            active={s.id === activeId}
            attention={attentionBySession[s.id]}
            deleteDisabled={Boolean(runLocks[s.id])}
            onSelect={() => switchSession(s.id)}
            onDelete={() => deleteSession(s.id)}
          />
        ))}
        {sorted.length === 0 ? (
          <DropdownMenuItem disabled>
            {t("miniWindow.agentFilter.empty")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SessionRow({
  session,
  agentName,
  agentIcon,
  active,
  attention,
  deleteDisabled,
  onSelect,
  onDelete,
}: {
  session: SessionMeta;
  agentName: string;
  agentIcon: SessionMeta["agentIcon"];
  active: boolean;
  attention?: SessionAttention;
  deleteDisabled: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation("ai");
  const updatedAt = formatMessageTimestamp(session.updatedAt, i18n.language);

  return (
    <DropdownMenuItem
      onSelect={(e) => {
        // 删除按钮由下方逻辑单独处理，此处不能提前关闭菜单。
        const target = e.target as HTMLElement | null;
        if (target?.closest("[data-session-delete]")) {
          e.preventDefault();
          return;
        }
        onSelect();
      }}
      className={cn(
        "group flex items-center justify-between gap-2 text-xs",
        active && "bg-interactive-active",
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <SessionAttentionIndicator attention={attention} />
        {session.agentId !== MAIN_AGENT_ID ? (
          <HugeiconsIcon
            icon={AGENT_ICONS[agentIcon]}
            size={11}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground"
            aria-label={agentName}
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate">
          {session.title || t("miniWindow.newChat")}
        </span>
      </span>
      {updatedAt ? (
        <time
          dateTime={new Date(session.updatedAt).toISOString()}
          className="shrink-0 text-[10px] text-muted-foreground"
        >
          {updatedAt}
        </time>
      ) : null}
      <button
        type="button"
        disabled={deleteDisabled}
        data-session-delete
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title={t("miniWindow.deleteSession")}
        className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
      >
        <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.75} />
      </button>
    </DropdownMenuItem>
  );
}

/** 返回历史筛选器中的 Agent 名称，主 Agent 使用固定产品名称。 */
function agentDisplayLabel(agent: { id: string; name: string }): string {
  return agent.id === MAIN_AGENT_ID ? MAIN_AGENT.name : agent.name;
}

function SessionAttentionIndicator({
  attention,
}: {
  attention?: SessionAttention;
}) {
  const { t } = useTranslation("ai");
  const label = attention ? t(`miniWindow.sessionStatus.${attention}`) : null;
  return (
    <span className="flex w-2 shrink-0 items-center justify-center">
      {attention ? (
        <span
          role="img"
          aria-label={label ?? undefined}
          title={label ?? undefined}
          className={cn(
            "size-1.5 rounded-full",
            attention === "background-running" &&
              "animate-pulse bg-warning motion-reduce:animate-none",
            attention === "completed-unread" && "bg-success",
            attention === "error-unread" && "bg-destructive",
          )}
        />
      ) : null}
    </span>
  );
}

function EmptyState({
  onPick,
  disabled,
}: {
  onPick: (text: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation("ai");
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8 py-10 text-center">
      <img src="/logo.png" alt="Terax" className="size-14 opacity-90" />
      <div className="space-y-1.5">
        <p className="text-[14px] font-semibold tracking-tight">
          {t("miniWindow.empty.title")}
        </p>
        <p className="max-w-[18rem] text-[11.5px] leading-relaxed text-muted-foreground">
          {t("miniWindow.empty.description")}
        </p>
      </div>
      <div className="flex w-full flex-col gap-2.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.translationKey}
            type="button"
            disabled={disabled}
            onClick={() =>
              onPick(t(`miniWindow.suggestions.${s.translationKey}.text`))
            }
            className={cn(
              "group flex items-center gap-2.5 bg-card/70 rounded-lg px-2.5 py-2 border border-border text-left",
              "transition-colors hover:bg-interactive-hover hover:text-foreground",
              "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-card/70 disabled:hover:text-inherit",
            )}
          >
            <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/70 text-muted-foreground transition-colors group-hover:bg-interactive-active group-hover:text-foreground">
              <HugeiconsIcon icon={s.icon} size={13} strokeWidth={1.75} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium text-foreground">
                {t(`miniWindow.suggestions.${s.translationKey}.label`)}
              </div>
              <div className="text-[10.5px] text-muted-foreground">
                {t(`miniWindow.suggestions.${s.translationKey}.hint`)}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

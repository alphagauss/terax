/**
 * 本文件实现 AI 侧边栏的会话外壳、上下文指标和空状态入口。
 * 流式消息更新在此合并提交，避免头部统计和聊天正文按每个 delta 重渲染。
 */

import { useCommandStore } from "@/modules/ai/commands/store";
import { Hint } from "@/components/controls/tooltip";
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
import { Button } from "@/components/controls/button";
import { cn } from "@/lib/utils";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { currentWorkspaceBootstrap } from "@/modules/workspace-process";
import { type Chat, type UIMessage, useChat } from "@ai-sdk/react";
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
import { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseExternalAgentBinding } from "@/modules/ai/external-agents/runtime";
import { agentDisplayName, MAIN_AGENT_ID } from "@/modules/ai/lib/agents";
import { STREAM_RENDER_INTERVAL_MS } from "@/modules/ai/lib/chatRendering";
import { formatMessageTimestamp } from "@/modules/ai/lib/messageTimestamp";
import type { SessionMeta } from "@/modules/ai/lib/sessions";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import { loadChat } from "@/modules/ai/store/chatRuntime";
import {
  releaseUnusedChats,
  sessionMetadata,
  useChatStore,
} from "@/modules/ai/store/chatStore";
import {
  type SessionAttention,
  useSessionAttentionStore,
} from "@/modules/ai/store/sessionAttentionStore";
import { AGENT_ICONS } from "@/modules/ai/components/AgentSwitcher";
import { AiChatView } from "@/modules/ai/components/AiChat";
import { AiInputBarConnect } from "@/modules/ai/components/AiInputBar";
import { AiSidebarComposer } from "@/modules/ai/components/AiSidebarComposer";
import { ContextIndicator } from "@/modules/ai/components/ContextIndicator";

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
  useLayoutEffect(() => {
    useChatStore.getState().setChatViewVisible(visible);
    return () => useChatStore.getState().setChatViewVisible(false);
  }, [visible]);
  const readOnly = useChatStore((s) => {
    const session = s.sessions.find((item) => item.id === s.activeSessionId);
    return (
      session !== undefined &&
      session.environmentKey !== currentWorkspaceBootstrap().environmentKey
    );
  });
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-[12px] dark:bg-sidebar">
      {visible &&
        (sessionId ? (
          <SessionBody
            key={`${sessionId}:${revision}`}
            sessionId={sessionId}
            readOnly={readOnly}
          />
        ) : (
          <EmptyShell />
        ))}
      {hasComposer ? (
        <AiSidebarComposer />
      ) : (
        <AiInputBarConnect onAdd={() => void openSettingsWindow("models")} />
      )}
    </div>
  );
}

/** 展示加载与业务运行解耦，隐藏时卸载订阅，重新显示时冷恢复已释放的历史。 */
function SessionBody({
  sessionId,
  readOnly,
}: {
  sessionId: string;
  readOnly: boolean;
}) {
  const [chat, setChat] = useState<Chat<UIMessage> | null>(null);
  useEffect(() => {
    let active = true;
    void loadChat(sessionId).then(
      (loaded) => {
        if (active) setChat(loaded);
        else releaseUnusedChats();
      },
      (error: unknown) => {
        if (active) useChatStore.setState({ sessionSyncError: String(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [sessionId]);
  return chat ? (
    <Body sessionId={sessionId} readOnly={readOnly} chat={chat} />
  ) : (
    <EmptyShell />
  );
}

function Body({
  sessionId,
  readOnly,
  chat,
}: {
  sessionId: string;
  readOnly: boolean;
  chat: Chat<UIMessage>;
}) {
  const focusInput = useChatStore((s) => s.focusInput);
  const hasCommands = useCommandStore((state) =>
    Boolean(state.sessions[sessionId]?.length),
  );
  const helpers = useChat<UIMessage>({
    chat,
    experimental_throttle: STREAM_RENDER_INTERVAL_MS,
  });
  const isBusy =
    helpers.status === "submitted" || helpers.status === "streaming";
  const showHeaderRunStatus =
    isBusy && !parseExternalAgentBinding(sessionMetadata.get(sessionId));

  return (
    <>
      <Header
        sessionId={sessionId}
        isBusy={showHeaderRunStatus}
        messages={helpers.messages}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        {helpers.messages.length === 0 && !hasCommands ? (
          <EmptyState onPick={focusInput} disabled={readOnly} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col [&_.text-sm]:text-[12px] [&_p]:leading-relaxed">
            <AiChatView
              sessionId={sessionId}
              messages={helpers.messages}
              status={helpers.status}
              error={helpers.error}
              clearError={helpers.clearError}
            />
          </div>
        )}
      </div>
    </>
  );
}

function EmptyShell() {
  const { t } = useTranslation("ai");
  return (
    <>
      <Header sessionId={null} isBusy={false} />
      <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
        {t("miniWindow.loadingSessions")}
      </div>
    </>
  );
}

function Header({
  sessionId,
  isBusy,
  messages,
}: {
  sessionId: string | null;
  isBusy: boolean;
  messages?: UIMessage[];
}) {
  const { t } = useTranslation("ai");
  const newSession = useChatStore((s) => s.newSession);

  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-sidebar px-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <SessionPicker />
        {messages !== undefined && (
          <ContextIndicator
            sessionId={sessionId}
            isBusy={isBusy}
            messages={messages}
          />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Hint content={t("miniWindow.aiSettings")}>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => void openSettingsWindow("models")}
            className="shrink-0"
            aria-label={t("miniWindow.aiSettings")}
          >
            <HugeiconsIcon icon={Wrench01Icon} size={15} strokeWidth={1.75} />
          </Button>
        </Hint>
        <Hint content={t("miniWindow.newSession")}>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => newSession()}
            className="shrink-0"
            aria-label={t("miniWindow.newSession")}
          >
            <HugeiconsIcon
              icon={PencilEdit02Icon}
              size={15}
              strokeWidth={1.75}
            />
          </Button>
        </Hint>
      </div>
    </div>
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
  const agents = useAgentsStore((state) => state.agents);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const isDraft = activeId != null && !active;
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
        <Hint content={t("miniWindow.switchSession")}>
          <button
            aria-label={t("miniWindow.switchSession")}
            type="button"
            className={cn(
              "flex min-w-0 max-w-48 items-center gap-1 rounded-md px-1.5 py-1",
              "text-[11px] text-foreground outline-none transition-colors",
              "hover:bg-accent hover:text-foreground",
              "focus-visible:outline-none",
            )}
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
        </Hint>
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
                    <span className="truncate">{agentDisplayName(agent)}</span>
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
      <Hint content={t("miniWindow.deleteSession")}>
        <button
          aria-label={t("miniWindow.deleteSession")}
          type="button"
          disabled={deleteDisabled}
          data-session-delete
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
        >
          <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.75} />
        </button>
      </Hint>
    </DropdownMenuItem>
  );
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
        <Hint content={label ?? undefined}>
          <span
            role="img"
            aria-label={label ?? undefined}
            className={cn(
              "size-1.5 rounded-full",
              attention === "background-running" && "bg-warning",
              attention === "completed-unread" && "bg-success",
              attention === "error-unread" && "bg-destructive",
            )}
          />
        </Hint>
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

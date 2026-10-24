/**
 * 本文件实现 AI 侧边栏的会话外壳、上下文指标和空状态入口。
 * 流式消息更新在此合并提交，避免头部统计和聊天正文按每个 delta 重渲染。
 */
import { Button } from "@/components/controls/button";
import { Hint } from "@/components/controls/tooltip";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useCommandStore } from "@/modules/ai/commands/store";
import {
  AGENT_ICONS,
  AgentPicker,
  SessionAgentIdentity,
} from "@/modules/ai/components/AgentSwitcher";
import { AiChatView } from "@/modules/ai/components/AiChat";
import { AiInputBarConnect } from "@/modules/ai/components/AiInputBar";
import { AiSidebarComposer } from "@/modules/ai/components/AiSidebarComposer";
import { ContextIndicator } from "@/modules/ai/components/ContextIndicator";
import { parseExternalAgentBinding } from "@/modules/ai/external-agents/runtime";
import { agentDisplayName, MAIN_AGENT_ID } from "@/modules/ai/lib/agents";
import { STREAM_RENDER_INTERVAL_MS } from "@/modules/ai/lib/chatRendering";
import { formatMessageTimestamp } from "@/modules/ai/lib/messageTimestamp";
import {
  type SessionMeta,
  searchSessionContents,
} from "@/modules/ai/lib/sessions";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import { loadChat } from "@/modules/ai/store/chatRuntime";
import {
  releaseUnusedChats,
  retainSessionView,
  sessionMetadata,
  useChatStore,
} from "@/modules/ai/store/chatStore";
import {
  type SessionAttention,
  useSessionAttentionStore,
} from "@/modules/ai/store/sessionAttentionStore";
import { useDeliveryHistory } from "@/modules/channels/history";
import {
  FindControlButton,
  FindPatternField,
  type FindPatternFieldHandle,
} from "@/modules/find";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import {
  type Chat,
  type UIMessage,
  type UseChatHelpers,
  useChat,
} from "@ai-sdk/react";
import {
  ChatDisplayContext,
  useChatDisplayActive,
  useChatDisplayStore,
} from "@/modules/ai/hooks/chatDisplay";
import AiChat01Icon from "@hugeicons/core-free-icons/AiChat01Icon";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import CleanIcon from "@hugeicons/core-free-icons/CleanIcon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";
import MessageSearch01Icon from "@hugeicons/core-free-icons/MessageSearch01Icon";
import PencilEdit02Icon from "@hugeicons/core-free-icons/PencilEdit02Icon";
import ServerStack03Icon from "@hugeicons/core-free-icons/ServerStack03Icon";
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon";
import Wrench01Icon from "@hugeicons/core-free-icons/Wrench01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const SESSION_SEARCH_DEBOUNCE_MS = 220;

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
  return (
    <div
      data-ai-sidebar-panel
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-[12px] dark:bg-sidebar"
    >
      <ChatDisplayContext value={visible}>
        {sessionId ? (
          <SessionBody key={`${sessionId}:${revision}`} sessionId={sessionId} />
        ) : (
          <EmptyShell />
        )}
      </ChatDisplayContext>
      {hasComposer ? (
        <AiSidebarComposer visible={visible} />
      ) : (
        <AiInputBarConnect onAdd={() => void openSettingsWindow("models")} />
      )}
    </div>
  );
}

/** 只保留当前会话的视图引用；收起不断开实例，切换会话或销毁面板时释放。 */
function SessionBody({ sessionId }: { sessionId: string }) {
  const [chat, setChat] = useState<Chat<UIMessage> | null>(null);
  useLayoutEffect(() => retainSessionView(sessionId), [sessionId]);
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
  return chat ? <Body sessionId={sessionId} chat={chat} /> : <EmptyShell />;
}

function Body({
  sessionId,
  chat,
}: {
  sessionId: string;
  chat: Chat<UIMessage>;
}) {
  const visible = useChatDisplayActive();
  const [helpers, setHelpers] = useState<ChatDisplayState>(() => ({
    messages: chat.messages,
    status: chat.status,
    error: chat.error,
    clearError: chat.clearError,
  }));
  const hasDeliveries = useChatDisplayStore(useDeliveryHistory, (state) =>
    Boolean(state.sessions[sessionId]?.length),
  );
  const hasCommands = useChatDisplayStore(useCommandStore, (state) =>
    Boolean(state.sessions[sessionId]?.length),
  );
  const isBusy =
    helpers.status === "submitted" || helpers.status === "streaming";
  const showHeaderRunStatus =
    isBusy && !parseExternalAgentBinding(sessionMetadata.get(sessionId));

  return (
    <>
      {visible && <ChatDisplaySubscription chat={chat} onChange={setHelpers} />}
      <Header
        sessionId={sessionId}
        isBusy={showHeaderRunStatus}
        messages={helpers.messages}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        {helpers.messages.length === 0 && !hasCommands && !hasDeliveries ? (
          <EmptyState />
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

type ChatDisplayState = Pick<
  UseChatHelpers<UIMessage>,
  "messages" | "status" | "error" | "clearError"
>;

/** SDK 订阅单独挂载，暂停订阅时不销毁消息 DOM 或重新初始化卡片。 */
function ChatDisplaySubscription({
  chat,
  onChange,
}: {
  chat: Chat<UIMessage>;
  onChange: (state: ChatDisplayState) => void;
}) {
  const { messages, status, error, clearError } = useChat({
    chat,
    experimental_throttle: STREAM_RENDER_INTERVAL_MS,
  });
  useLayoutEffect(() => {
    onChange({ messages, status, error, clearError });
  }, [messages, status, error, clearError, onChange]);
  return null;
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
  const visible = useChatDisplayActive();
  const newSession = useChatStore((s) => s.newSession);
  // 工具栏仅保留固定占位；菜单与提示随隐藏关闭，不需要逐个维护展示状态。
  if (!visible) return <div className="h-10 shrink-0" />;

  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-sidebar px-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <SessionPicker />
        {messages !== undefined && (
          <>
            <ContextIndicator
              sessionId={sessionId}
              isBusy={isBusy}
              messages={messages}
            />
            <SessionAgentIdentity sessionId={sessionId} />
          </>
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
  const filterPanelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<FindPatternFieldHandle>(null);
  const searchRequestRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterKind, setFilterKind] = useState<
    "agent" | "directory" | "environment"
  >("agent");
  const [query, setQuery] = useState("");
  const [includeContent, setIncludeContent] = useState(false);
  const [contentMatches, setContentMatches] = useState<Record<string, string>>(
    {},
  );
  const [contentSearchLoading, setContentSearchLoading] = useState(false);
  const [contentSearchError, setContentSearchError] = useState(false);
  const [panelSize, setPanelSize] = useState({ width: 280, height: 800 });
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeSessionId);
  const runLocks = useChatStore((s) => s.runLockSessionIds);
  const attentionBySession = useSessionAttentionStore((s) => s.bySession);
  const switchSession = useChatStore((s) => s.switchSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const agentFilter = useChatStore((state) => state.sessionAgentFilter);
  const setAgentFilter = useChatStore((state) => state.setSessionAgentFilter);
  const directoryFilter = useChatStore((state) => state.sessionDirectoryFilter);
  const setDirectoryFilter = useChatStore(
    (state) => state.setSessionDirectoryFilter,
  );
  const environmentFilter = useChatStore(
    (state) => state.sessionEnvironmentFilter,
  );
  const setEnvironmentFilter = useChatStore(
    (state) => state.setSessionEnvironmentFilter,
  );
  const agents = useAgentsStore((state) => state.agents);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const isDraft = activeId != null && !active;
  const selectedAgent = agents.find((agent) => agent.id === agentFilter);
  useLayoutEffect(() => {
    const panel = triggerRef.current?.closest<HTMLElement>(
      "[data-ai-sidebar-panel]",
    );
    if (!panel) return;
    const updateSize = () => {
      const { width, height } = panel.getBoundingClientRect();
      if (width > 0 && height > 0) setPanelSize({ width, height });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (
      agentFilter !== null &&
      !agents.some((agent) => agent.id === agentFilter)
    ) {
      setAgentFilter(null);
    }
  }, [agentFilter, agents, setAgentFilter]);
  const filteredSessions = sessions
    .filter(
      (session) =>
        (agentFilter === null || session.agentId === agentFilter) &&
        (directoryFilter === null ||
          (session.environmentKey === directoryFilter.environmentKey &&
            session.cwd === directoryFilter.cwd)) &&
        (environmentFilter === null ||
          session.environmentKey === environmentFilter),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const normalizedQuery = query.trim().replace(/\s+/g, " ").toLowerCase();
  const contentSearchScope = filteredSessions
    .map((session) => `${session.id}:${session.fingerprint ?? ""}`)
    .join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: 轮询会重建列表，仅在搜索范围或会话指纹变化时重跑。
  useEffect(() => {
    const requestId = ++searchRequestRef.current;
    if (!open || !includeContent || !normalizedQuery) {
      setContentMatches({});
      setContentSearchLoading(false);
      setContentSearchError(false);
      return;
    }
    setContentMatches({});
    setContentSearchLoading(true);
    setContentSearchError(false);
    const timer = window.setTimeout(() => {
      const sessionIds = filteredSessions.map((session) => session.id);
      void searchSessionContents(normalizedQuery, sessionIds)
        .then((matches) => {
          if (requestId !== searchRequestRef.current) return;
          setContentMatches(
            Object.fromEntries(
              matches.map((match) => [match.id, match.preview]),
            ),
          );
        })
        .catch(() => {
          if (requestId !== searchRequestRef.current) return;
          setContentSearchError(true);
        })
        .finally(() => {
          if (requestId === searchRequestRef.current)
            setContentSearchLoading(false);
        });
    }, SESSION_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [contentSearchScope, includeContent, normalizedQuery, open]);
  const titleMatchIds = new Set(
    normalizedQuery
      ? filteredSessions
          .filter((session) =>
            session.title.toLowerCase().includes(normalizedQuery),
          )
          .map((session) => session.id)
      : filteredSessions.map((session) => session.id),
  );
  const sorted = normalizedQuery
    ? filteredSessions.filter(
        (session) =>
          titleMatchIds.has(session.id) ||
          (includeContent && contentMatches[session.id] !== undefined),
      )
    : filteredSessions;
  const sessionCountByAgent = new Map<string, number>();
  const directories = new Map<
    string,
    { environmentKey: string; cwd: string; count: number }
  >();
  const sessionCountByEnvironment = new Map<string, number>();
  const environmentsByCwd = new Map<string, Set<string>>();
  for (const session of sessions) {
    sessionCountByAgent.set(
      session.agentId,
      (sessionCountByAgent.get(session.agentId) ?? 0) + 1,
    );
    // 相同路径在不同环境中属于不同工作目录。
    const directoryKey = JSON.stringify([session.environmentKey, session.cwd]);
    const directory = directories.get(directoryKey);
    directories.set(directoryKey, {
      environmentKey: session.environmentKey,
      cwd: session.cwd,
      count: (directory?.count ?? 0) + 1,
    });
    sessionCountByEnvironment.set(
      session.environmentKey,
      (sessionCountByEnvironment.get(session.environmentKey) ?? 0) + 1,
    );
    const environments =
      environmentsByCwd.get(session.cwd) ?? new Set<string>();
    environments.add(session.environmentKey);
    environmentsByCwd.set(session.cwd, environments);
  }
  const environmentLabel = (key: string) =>
    key === "local"
      ? t("miniWindow.environmentFilter.local")
      : key.startsWith("wsl:")
        ? `WSL: ${key.slice(4)}`
        : key.startsWith("ssh:")
          ? `SSH: ${key.slice(4)}`
          : key;
  const directorySuffix = (directory: {
    environmentKey: string;
    cwd: string;
  }) =>
    environmentFilter === null &&
    (environmentsByCwd.get(directory.cwd)?.size ?? 0) > 1
      ? ` (${environmentLabel(directory.environmentKey)})`
      : "";
  const filters = [
    {
      id: "agent" as const,
      icon: AiChat01Icon,
      label: t("miniWindow.agentFilter.label"),
      all: t("miniWindow.agentFilter.all"),
      total: sessions.length,
      selected:
        agentFilter === null
          ? null
          : selectedAgent
            ? agentDisplayName(selectedAgent)
            : agentFilter,
      clear: () => setAgentFilter(null),
      options: agents.map((agent) => ({
        key: agent.id,
        label: agentDisplayName(agent),
        count: sessionCountByAgent.get(agent.id) ?? 0,
        selected: agentFilter === agent.id,
        onSelect: () => setAgentFilter(agent.id),
      })),
    },
    {
      id: "directory" as const,
      icon: Folder01Icon,
      label: t("miniWindow.directoryFilter.label"),
      all: t("miniWindow.directoryFilter.all"),
      total:
        environmentFilter === null
          ? sessions.length
          : (sessionCountByEnvironment.get(environmentFilter) ?? 0),
      selected:
        directoryFilter === null
          ? null
          : `${directoryFilter.cwd}${directorySuffix(directoryFilter)}`,
      clear: () => setDirectoryFilter(null),
      options: Array.from(directories)
        .filter(
          ([, directory]) =>
            environmentFilter === null ||
            directory.environmentKey === environmentFilter,
        )
        .map(([key, directory]) => ({
          key,
          label: directory.cwd,
          suffix: directorySuffix(directory),
          count: directory.count,
          selected:
            directoryFilter?.environmentKey === directory.environmentKey &&
            directoryFilter.cwd === directory.cwd,
          onSelect: () =>
            setDirectoryFilter({
              environmentKey: directory.environmentKey,
              cwd: directory.cwd,
            }),
        })),
    },
    {
      id: "environment" as const,
      icon: ServerStack03Icon,
      label: t("miniWindow.environmentFilter.label"),
      all: t("miniWindow.environmentFilter.all"),
      total: sessions.length,
      selected:
        environmentFilter === null ? null : environmentLabel(environmentFilter),
      clear: () => setEnvironmentFilter(null),
      options: Array.from(sessionCountByEnvironment, ([key, count]) => ({
        key,
        label: environmentLabel(key),
        count,
        selected: environmentFilter === key,
        onSelect: () => setEnvironmentFilter(key),
      })),
    },
  ];
  const expandedFilter = filters.find((filter) => filter.id === filterKind);
  if (!active && !isDraft) return null;

  const popoverWidth = Math.min(
    360,
    Math.max(240, Math.floor(panelSize.width * 0.9)),
  );
  const popoverMaxHeight = Math.min(640, Math.floor(panelSize.height * 0.7));

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) return;
    searchRequestRef.current += 1;
    setFilterOpen(false);
    setQuery("");
    setIncludeContent(false);
    setContentMatches({});
    setContentSearchLoading(false);
    setContentSearchError(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Hint content={t("miniWindow.switchSession")}>
          <button
            ref={triggerRef}
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
      </PopoverTrigger>
      <PopoverContent
        align="start"
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="gap-0 overflow-hidden rounded-2xl p-1"
        style={{
          width: popoverWidth,
          maxHeight: `min(${popoverMaxHeight}px, var(--radix-popover-content-available-height))`,
        }}
      >
        <Collapsible open={filterOpen}>
          <div className="flex items-center gap-1 pb-1">
            <FindPatternField
              ref={searchRef}
              query={query}
              onQueryChange={setQuery}
              placeholder={t("miniWindow.sessionSearch.placeholder")}
              trailingContent={
                <FindControlButton
                  label={t("miniWindow.sessionSearch.includeContent")}
                  active={includeContent}
                  onClick={() => {
                    setIncludeContent((current) => !current);
                    requestAnimationFrame(() => searchRef.current?.focus());
                  }}
                >
                  {contentSearchLoading ? (
                    <Spinner className="size-3" />
                  ) : (
                    <HugeiconsIcon
                      icon={MessageSearch01Icon}
                      size={13}
                      strokeWidth={1.9}
                    />
                  )}
                </FindControlButton>
              }
            />
            {filters.map((filter) => (
              <Hint
                key={filter.id}
                content={
                  filter.selected === null
                    ? filter.label
                    : `${filter.label}: ${filter.selected}`
                }
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    "shrink-0",
                    filter.selected !== null &&
                      "bg-interactive-active text-foreground",
                  )}
                  aria-label={filter.label}
                  aria-expanded={filterOpen && filterKind === filter.id}
                  aria-controls={filterPanelId}
                  onClick={() => {
                    setFilterKind(filter.id);
                    setFilterOpen((current) =>
                      filterKind === filter.id ? !current : true,
                    );
                  }}
                >
                  <HugeiconsIcon
                    icon={filter.icon}
                    size={18}
                    className="size-4.5"
                    strokeWidth={1.75}
                  />
                </Button>
              </Hint>
            ))}
            <Hint content={t("miniWindow.clearFilters")}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="shrink-0"
                aria-label={t("miniWindow.clearFilters")}
                disabled={filters.every((filter) => filter.selected === null)}
                onClick={() => {
                  for (const filter of filters) filter.clear();
                }}
              >
                <HugeiconsIcon
                  icon={CleanIcon}
                  size={18}
                  className="size-4.5"
                  strokeWidth={1.75}
                />
              </Button>
            </Hint>
          </div>
          <CollapsibleContent
            id={filterPanelId}
            className="terax-collapsible-content"
          >
            {expandedFilter && (
              <div
                role="radiogroup"
                aria-label={expandedFilter.label}
                className="max-h-48 overflow-y-auto pb-1"
              >
                <SessionFilterRow
                  name={`session-${expandedFilter.id}-filter`}
                  label={expandedFilter.all}
                  count={expandedFilter.total}
                  selected={expandedFilter.selected === null}
                  onSelect={expandedFilter.clear}
                />
                {expandedFilter.options.map(({ key, ...option }) => (
                  <SessionFilterRow
                    key={key}
                    name={`session-${expandedFilter.id}-filter`}
                    {...option}
                  />
                ))}
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
        <div className="mx-1 h-px shrink-0 bg-border" />
        <div className="min-h-0 flex-1 overflow-y-auto pt-1">
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
              preview={
                titleMatchIds.has(s.id) ? undefined : contentMatches[s.id]
              }
              deleteDisabled={Boolean(runLocks[s.id])}
              onSelect={() => {
                switchSession(s.id);
                handleOpenChange(false);
              }}
              onDelete={() => deleteSession(s.id)}
            />
          ))}
          {contentSearchError ? (
            <div className="px-2.5 py-1.5 text-xs text-destructive">
              {t("miniWindow.sessionSearch.failed")}
            </div>
          ) : sorted.length === 0 && !contentSearchLoading ? (
            <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
              {t("miniWindow.sessionSearch.empty")}
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SessionFilterRow({
  name,
  label,
  suffix,
  count,
  selected,
  onSelect,
}: {
  name: string;
  label: string;
  suffix?: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-xl py-1.5 pr-2.5 pl-7 text-left text-xs",
        "hover:bg-accent focus-within:bg-accent",
        selected && "bg-interactive-active",
      )}
    >
      <input
        type="radio"
        name={name}
        checked={selected}
        onChange={onSelect}
        className="peer sr-only"
      />
      <HugeiconsIcon
        icon={Tick02Icon}
        size={11}
        strokeWidth={2}
        className="absolute left-2.5 opacity-0 peer-checked:opacity-100"
      />
      <span className="min-w-0 flex-1 truncate">
        {label}
        {suffix && (
          <span className="text-[10px] text-muted-foreground">{suffix}</span>
        )}
      </span>
      <span className="shrink-0 text-muted-foreground">{count}</span>
    </label>
  );
}

function SessionRow({
  session,
  agentName,
  agentIcon,
  active,
  attention,
  preview,
  deleteDisabled,
  onSelect,
  onDelete,
}: {
  session: SessionMeta;
  agentName: string;
  agentIcon: SessionMeta["agentIcon"];
  active: boolean;
  attention?: SessionAttention;
  preview?: string;
  deleteDisabled: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation("ai");
  const updatedAt = formatMessageTimestamp(session.updatedAt, i18n.language);

  return (
    <div
      className={cn(
        "group flex items-center rounded-xl text-xs hover:bg-accent focus-within:bg-accent",
        active && "bg-interactive-active",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="relative flex min-w-0 flex-1 items-start gap-1 py-1.5 pl-2.5 text-left outline-none"
      >
        <SessionAttentionIndicator attention={attention} />
        {session.agentId !== MAIN_AGENT_ID ? (
          <HugeiconsIcon
            icon={AGENT_ICONS[agentIcon]}
            size={11}
            strokeWidth={1.75}
            className={cn(
              "shrink-0 text-muted-foreground",
              preview && "mt-0.5",
            )}
            aria-label={agentName}
          />
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">
            {session.title || t("miniWindow.newChat")}
          </span>
          {preview ? (
            <span className="truncate text-[10px] text-muted-foreground">
              {preview}
            </span>
          ) : null}
        </span>
        {updatedAt ? (
          <time
            dateTime={new Date(session.updatedAt).toISOString()}
            className="ml-1 shrink-0 text-[10px] text-muted-foreground"
          >
            {updatedAt}
          </time>
        ) : null}
      </button>
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
          className="mr-2 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
        >
          <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.75} />
        </button>
      </Hint>
    </div>
  );
}

function SessionAttentionIndicator({
  attention,
}: {
  attention?: SessionAttention;
}) {
  const { t } = useTranslation("ai");
  if (!attention) return null;
  const label = t(`miniWindow.sessionStatus.${attention}`);
  return (
    <Hint content={label}>
      <span
        role="img"
        aria-label={label}
        className={cn(
          "absolute top-2.5 left-0.5 size-1.5 rounded-full",
          attention === "background-running" && "bg-warning",
          attention === "completed-unread" && "bg-success",
          attention === "error-unread" && "bg-destructive",
        )}
      />
    </Hint>
  );
}

function EmptyState() {
  const visible = useChatDisplayActive();
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
      {visible && <AgentPicker />}
    </div>
  );
}

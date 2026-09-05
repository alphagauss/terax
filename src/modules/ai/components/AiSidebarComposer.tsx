/**
 * 本文件实现 AI 侧边栏 Composer 及其模型选择界面。
 * 负责输入、上下文标签、模型筛选和发送控制。
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import { ProviderIcon } from "@/modules/ai/components/ProviderIcon";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  Add01Icon,
  AiBookIcon,
  ArrowDown01Icon,
  ArrowUp02Icon,
  Clock01Icon,
  FavouriteIcon,
  Folder01Icon,
  HandIcon,
  Mic01Icon,
  PlugIcon,
  Search01Icon,
  SecurityWarningIcon,
  StarIcon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type ModelRef,
  modelRefKey,
  modelRefsEqual,
  PROVIDERS,
  type ProviderId,
  providerFromBuiltinId,
  type ResolvedModel,
  resolveModel,
  STT_PROVIDER_LABELS,
  tryResolveModel,
} from "@/modules/ai/config";
import {
  EXTERNAL_AGENTS,
  parseExternalAgentBinding,
} from "@/modules/ai/external-agents/runtime";
import { ACCEPTED_FILES, useComposer } from "@/modules/ai/lib/composer";
import { getAvailableModelRefs } from "@/modules/ai/lib/modelAvailability";
import { toggleFavoriteModel } from "@/modules/ai/lib/modelPrefs";
import { sessionMetadata, useChatStore } from "@/modules/ai/store/chatStore";
import { AiComposerInput } from "@/modules/ai/components/AiComposerInput";
import "@/modules/ai/components/ai-sidebar-composer.css";
import { ChipsRow } from "@/modules/ai/components/ChipsRow";

/**
 * AI 侧栏输入组件。
 * 负责附件、模型和权限选择；运行中有输入时提供引导，并始终保留中止入口。
 */
export function AiSidebarComposer() {
  const { t } = useTranslation("ai");
  const c = useComposer();
  const guiding = c.isBusy && c.canSend;
  const stopping = c.isBusy && !guiding;
  const submitLabel = t(
    stopping
      ? "statusBar.stop"
      : guiding
        ? "statusBar.steer"
        : "statusBar.send",
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workingDirectoryContent = c.workingDirectory ? (
    <>
      <HugeiconsIcon
        icon={Folder01Icon}
        size={12}
        strokeWidth={1.75}
        className="shrink-0"
      />
      <span className="truncate font-mono">{c.workingDirectory}</span>
    </>
  ) : null;

  return (
    <div className="relative z-10 shrink-0 px-3 pb-3">
      <div className="flex flex-col gap-2 rounded-2xl border border-border/70 bg-background/95 p-2.5 shadow-sm">
        <input
          ref={fileInputRef}
          type="file"
          disabled={c.readOnly}
          multiple
          accept={ACCEPTED_FILES}
          className="hidden"
          onChange={(e) => {
            void c.addFiles(e.target.files);
            e.target.value = "";
          }}
        />

        <ChipsRow
          files={c.files}
          onRemoveFile={c.removeFile}
          snippets={c.pickedSnippets}
          onRemoveSnippet={(id) => {
            const snippet = c.pickedSnippets.find((item) => item.id === id);
            c.removeSnippet(id);
            if (!snippet) return;
            const pattern = new RegExp(`(^|\\s)#${snippet.handle}\\b ?`);
            c.setValue((value) =>
              value.replace(pattern, (_match, lead: string) => lead),
            );
          }}
          commands={c.pickedCommands}
          onRemoveCommand={c.removeCommand}
        />

        <AiComposerInput />
        {c.pendingSteering > 0 ? (
          <p role="status" className="px-1 text-xs text-muted-foreground">
            {t("composer.pendingSteering", { count: c.pendingSteering })}
          </p>
        ) : null}

        <div className="terax-ai-composer-toolbar flex min-w-0 items-center gap-0.5">
          <IconBtn
            title={t("statusBar.attachFileOrImage")}
            onClick={() => fileInputRef.current?.click()}
            disabled={c.readOnly || (c.isBusy && !c.canSteer)}
          >
            <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={2} />
          </IconBtn>

          {c.voice.supported ? (
            <IconBtn
              title={
                !c.voice.hasKey
                  ? t("statusBar.voiceNeedsKey", {
                      provider: STT_PROVIDER_LABELS[c.voice.sttProvider],
                    })
                  : c.voice.recording
                    ? t("statusBar.stopAndTranscribe")
                    : c.voice.transcribing
                      ? t("statusBar.transcribing")
                      : t("statusBar.voiceInput")
              }
              onClick={() =>
                c.voice.recording ? c.voice.stop() : void c.voice.start()
              }
              disabled={
                c.isBusy ||
                c.readOnly ||
                c.voice.transcribing ||
                !c.voice.hasKey
              }
              className={cn(
                c.voice.recording &&
                  "bg-destructive/10 text-destructive hover:bg-destructive/15",
              )}
            >
              {c.voice.recording ? (
                <span className="size-2 animate-pulse rounded-full bg-destructive" />
              ) : c.voice.transcribing ? (
                <Spinner className="size-3" />
              ) : (
                <HugeiconsIcon icon={Mic01Icon} size={13} strokeWidth={1.75} />
              )}
            </IconBtn>
          ) : null}

          <ModelDropdown />
          <span className="min-w-1 flex-1" />

          {guiding ? (
            <IconBtn title={t("statusBar.stop")} onClick={c.stop}>
              <span className="size-2 rounded-[2px] bg-current" />
            </IconBtn>
          ) : null}
          <Button
            type="button"
            size="icon"
            onClick={stopping ? c.stop : c.submit}
            disabled={c.readOnly || (!c.isBusy && !c.canSend)}
            className={cn(
              "size-7 rounded-full bg-foreground text-background transition-[background-color,color,opacity,transform] duration-control hover:bg-foreground/85",
              guiding &&
                "bg-primary text-primary-foreground hover:bg-primary/85",
            )}
            aria-label={submitLabel}
            title={submitLabel}
          >
            {stopping ? (
              <span className="size-2 rounded-[2px] bg-current" />
            ) : (
              <HugeiconsIcon icon={ArrowUp02Icon} size={14} strokeWidth={2} />
            )}
          </Button>
        </div>

        {c.workingDirectory ? (
          c.canRevealWorkingDirectory ? (
            <button
              type="button"
              disabled={c.revealingWorkingDirectory}
              onClick={c.revealWorkingDirectory}
              className="flex min-w-0 items-center gap-1.5 rounded px-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none"
              aria-label={t("composer.workingDirectory", {
                path: c.workingDirectory,
              })}
            >
              {workingDirectoryContent}
            </button>
          ) : (
            <div
              className="flex min-w-0 items-center gap-1.5 px-1 text-[11px] text-muted-foreground"
              title={t("composer.workingDirectory", {
                path: c.workingDirectory,
              })}
            >
              {workingDirectoryContent}
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}

const PERMISSION_MODES = [
  { id: "ask", icon: HandIcon },
  { id: "full-access", icon: SecurityWarningIcon },
] as const;

/** 选择当前 Workspace 进程内的 AI 工具审批模式。 */
function PermissionModeDropdown() {
  const { t } = useTranslation("ai");
  const { readOnly } = useComposer();
  const mode = useChatStore((s) =>
    s.sessions.find((session) => session.id === s.activeSessionId)?.channelId
      ? "full-access"
      : s.permissionMode,
  );
  const setMode = useChatStore((s) => s.setPermissionMode);
  const activeIcon = mode === "ask" ? HandIcon : SecurityWarningIcon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          disabled={readOnly}
          variant="ghost"
          size="sm"
          className={cn(
            "my-1 h-5.5 shrink-0 gap-1 rounded-md px-1.5 text-xs hover:bg-accent focus-visible:border-transparent focus-visible:ring-0",
            mode === "full-access"
              ? "text-amber-600! dark:text-amber-400!"
              : "text-foreground!",
          )}
          title={t(`statusBar.permissionMode.${mode}`)}
          aria-label={t(`statusBar.permissionMode.${mode}`)}
        >
          <HugeiconsIcon icon={activeIcon} size={13} strokeWidth={1.75} />
          <span className="terax-ai-permission-label">
            {t(`statusBar.permissionMode.${mode}`)}
          </span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={11}
            strokeWidth={2}
            className="terax-ai-permission-chevron"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {PERMISSION_MODES.map((item) => (
          <DropdownMenuItem
            key={item.id}
            onSelect={() => setMode(item.id)}
            className={
              item.id === "full-access"
                ? "text-amber-600! **:text-amber-600! dark:text-amber-400! dark:**:text-amber-400!"
                : "text-foreground! **:text-foreground!"
            }
          >
            <HugeiconsIcon icon={item.icon} size={14} strokeWidth={1.75} />
            {t(`statusBar.permissionMode.${item.id}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type Tab = "all" | "favorites" | "recent";

/** 展示会话使用的模型，外部消息会话沿用输入禁用规则。 */
function ModelDropdown() {
  const { t } = useTranslation("ai");
  const { readOnly } = useComposer();
  const channelId = useChatStore(
    (s) =>
      s.sessions.find((session) => session.id === s.activeSessionId)?.channelId,
  );
  const selectedUiModel = useChatStore((s) => s.selectedModel);
  const defaultModel = usePreferencesStore((s) => s.defaultModel);
  const selected = channelId ? defaultModel : selectedUiModel;
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const draftSessionId = useChatStore((s) => s.draftSessionId);
  const draftExternalAgentId = useChatStore((s) => s.draftExternalAgentId);
  const setDraftExternalAgent = useChatStore((s) => s.setDraftExternalAgent);
  const newSession = useChatStore((s) => s.newSession);
  const externalAvailability = useChatStore((s) => s.externalAgentAvailability);
  const apiKeys = useChatStore((s) => s.apiKeys);
  const setSelected = useChatStore((s) => s.setSelectedModel);
  const favoriteModels = usePreferencesStore((s) => s.favoriteModels);
  const recentModels = usePreferencesStore((s) => s.recentModels);
  const customProviders = usePreferencesStore((s) => s.customProviders);
  const customProviderById = useMemo(
    () => new Map(customProviders.map((provider) => [provider.id, provider])),
    [customProviders],
  );
  const providerModels = usePreferencesStore((s) => s.providerModels);
  const providerBaseURLs = usePreferencesStore((s) => s.providerBaseURLs);
  const [search, setSearch] = useState("");
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const inputRef = useRef<HTMLInputElement>(null);
  type ModelOption = { ref: ModelRef; info: ResolvedModel };
  const modelOptions = useMemo<ModelOption[]>(() => {
    return getAvailableModelRefs({
      apiKeys,
      providerModels,
      providerBaseURLs,
      customProviders,
    }).map((ref) => ({
      ref,
      info: resolveModel(ref, { customProviders, providerBaseURLs }),
    }));
  }, [apiKeys, customProviders, providerBaseURLs, providerModels]);

  const COMPAT_PROVIDER_ID = "__compat__";
  const availableProviderIds = useMemo(
    () =>
      new Set(
        modelOptions.flatMap(({ ref }) => {
          const provider = providerFromBuiltinId(ref.providerId);
          return provider ? [provider] : [];
        }),
      ),
    [modelOptions],
  );
  const hasCustomModels = modelOptions.some(({ ref }) =>
    customProviderById.has(ref.providerId),
  );
  const effectiveActiveProvider =
    activeProvider === COMPAT_PROVIDER_ID
      ? hasCustomModels
        ? activeProvider
        : null
      : activeProvider === null ||
          availableProviderIds.has(activeProvider as ProviderId)
        ? activeProvider
        : null;
  const currentRef =
    modelOptions.find(
      ({ ref }) => selected !== null && modelRefsEqual(ref, selected),
    )?.ref ??
    modelOptions[0]?.ref ??
    null;
  const current = tryResolveModel(currentRef, {
    customProviders,
    providerBaseURLs,
  });
  const persistedExternal = parseExternalAgentBinding(
    activeSessionId ? sessionMetadata.get(activeSessionId) : undefined,
  );
  const currentExternalId =
    persistedExternal?.agentId ??
    (activeSessionId === draftSessionId ? draftExternalAgentId : null);
  const currentExternal = EXTERNAL_AGENTS.find(
    (agent) => agent.id === currentExternalId,
  );
  const availableExternalAgents = EXTERNAL_AGENTS.filter(
    (agent) =>
      externalAvailability?.some(
        (available) => available.agentId === agent.id && available.installed,
      ) &&
      tab === "all" &&
      activeProvider === null &&
      (!search.trim() ||
        agent.label.toLowerCase().includes(search.trim().toLowerCase())),
  );
  const availableFavoriteCount = modelOptions.filter(({ ref }) =>
    favoriteModels.some((favorite) => modelRefsEqual(favorite, ref)),
  ).length;
  const availableRecentCount = modelOptions.filter(({ ref }) =>
    recentModels.some((recent) => modelRefsEqual(recent, ref)),
  ).length;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let pool = modelOptions;
    if (tab === "favorites") {
      pool = pool.filter((option) =>
        favoriteModels.some((ref) => modelRefsEqual(ref, option.ref)),
      );
    } else if (tab === "recent") {
      const order = new Map(
        recentModels.map((ref, index) => [modelRefKey(ref), index]),
      );
      pool = pool
        .filter((option) => order.has(modelRefKey(option.ref)))
        .slice()
        .sort(
          (a, b) =>
            (order.get(modelRefKey(a.ref)) ?? 0) -
            (order.get(modelRefKey(b.ref)) ?? 0),
        );
    }
    if (effectiveActiveProvider === COMPAT_PROVIDER_ID) {
      pool = pool.filter((option) =>
        customProviderById.has(option.ref.providerId),
      );
    } else if (effectiveActiveProvider !== null) {
      pool = pool.filter(
        (option) => option.info.provider === effectiveActiveProvider,
      );
    }
    if (q) {
      pool = pool.filter(
        ({ info: model }) =>
          model.label.toLowerCase().includes(q) ||
          (customProviderById.get(model.providerId)?.name ?? model.provider)
            .toLowerCase()
            .includes(q),
      );
    }
    return pool;
  }, [
    customProviderById,
    effectiveActiveProvider,
    favoriteModels,
    modelOptions,
    recentModels,
    search,
    tab,
  ]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={
            readOnly ||
            (!current &&
              !currentExternal &&
              availableExternalAgents.length === 0)
          }
          className={cn(
            "my-1 h-5.5 min-w-0 shrink gap-1 rounded-md px-1.5 text-xs hover:bg-accent hover:text-foreground",
            "text-muted-foreground",
          )}
          title={
            currentExternal || current
              ? t("statusBar.modelTitle", {
                  label: currentExternal?.label ?? current?.label,
                })
              : t("statusBar.noModels")
          }
        >
          <span className="truncate">
            {currentExternal?.label ??
              current?.label ??
              t("statusBar.noModels")}
          </span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={11}
            strokeWidth={2}
            className="opacity-70"
          />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="w-max min-w-72 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-border/70 p-0 shadow-xl"
        onFocusCapture={(e) => {
          if (e.target !== inputRef.current) inputRef.current?.focus();
        }}
      >
        {/* Search */}
        <div className="flex items-center gap-2.5 border-b border-border/70 px-3 py-2.5">
          <HugeiconsIcon
            icon={Search01Icon}
            size={16}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground"
          />
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder={t("statusBar.searchPlaceholder")}
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
          />
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-0.5 border-b border-border/70 px-2 py-1.5">
          <TabButton
            label={t("statusBar.tabAll")}
            icon={AiBookIcon}
            active={tab === "all"}
            onClick={() => setTab("all")}
          />
          <TabButton
            label={t("statusBar.tabFavorites")}
            icon={FavouriteIcon}
            active={tab === "favorites"}
            onClick={() => setTab("favorites")}
            count={availableFavoriteCount || undefined}
          />
          <TabButton
            label={t("statusBar.tabRecent")}
            icon={Clock01Icon}
            active={tab === "recent"}
            onClick={() => setTab("recent")}
            count={availableRecentCount || undefined}
          />
        </div>

        <div className="flex min-h-0 max-h-[calc(var(--radix-dropdown-menu-content-available-height)-5rem)]">
          {/* 供应商列只展示至少包含一个当前可用模型的配置。 */}
          <div className="flex w-11 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border/70 bg-muted/20 py-1.5">
            <ProviderPill
              icon={AiBookIcon}
              title={t("statusBar.allProviders")}
              active={effectiveActiveProvider === null}
              onClick={() => setActiveProvider(null)}
            />
            {PROVIDERS.filter((provider) =>
              availableProviderIds.has(provider.id),
            ).map((p) => (
              <ProviderPill
                key={p.id}
                provider={p.id}
                title={p.label}
                active={effectiveActiveProvider === p.id}
                onClick={() => setActiveProvider(p.id)}
              />
            ))}
            {hasCustomModels && (
              <ProviderPill
                icon={PlugIcon}
                title={t("statusBar.openaiCompatible")}
                active={effectiveActiveProvider === COMPAT_PROVIDER_ID}
                onClick={() => setActiveProvider(COMPAT_PROVIDER_ID)}
              />
            )}
          </div>

          {/* Models list */}
          <div className="min-h-0 min-w-52 max-w-96 flex-1 overflow-x-hidden overflow-y-auto py-1">
            {effectiveActiveProvider === COMPAT_PROVIDER_ID && (
              <div className="flex items-center gap-1.5 px-3 pt-1 pb-1.5 text-[11px] font-medium tracking-tight text-muted-foreground">
                <HugeiconsIcon icon={PlugIcon} size={13} strokeWidth={1.75} />
                <span>{t("statusBar.openaiCompatible")}</span>
              </div>
            )}
            {effectiveActiveProvider !== null &&
            effectiveActiveProvider !== COMPAT_PROVIDER_ID ? (
              <ProviderHeader
                providerId={effectiveActiveProvider as ProviderId}
              />
            ) : null}
            {availableExternalAgents.length > 0 ? (
              <>
                <div className="px-3 pt-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
                  {t("statusBar.externalAgents")}
                </div>
                {availableExternalAgents.map((agent) => (
                  <DropdownMenuItem
                    key={agent.id}
                    className="mx-1 flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5"
                    onSelect={() => {
                      if (persistedExternal?.agentId === agent.id) return;
                      if (
                        activeSessionId &&
                        activeSessionId !== draftSessionId
                      ) {
                        newSession();
                      }
                      setDraftExternalAgent(agent.id);
                    }}
                  >
                    <AgentIcon agent={agent.id} size={15} />
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {agent.label}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {t("statusBar.local")}
                    </span>
                    {currentExternalId === agent.id ? (
                      <HugeiconsIcon icon={Tick01Icon} size={13} />
                    ) : null}
                  </DropdownMenuItem>
                ))}
                {filtered.length > 0 ? (
                  <div className="mx-2 my-1 h-px bg-border/50" />
                ) : null}
              </>
            ) : null}
            {filtered.length === 0 && availableExternalAgents.length === 0 ? (
              <div className="flex items-center justify-center px-4 py-10 text-xs text-muted-foreground">
                {tab === "favorites"
                  ? t("statusBar.noFavorites")
                  : tab === "recent"
                    ? t("statusBar.noRecent")
                    : t("statusBar.noMatch")}
              </div>
            ) : (
              filtered.map(({ ref, info }) => (
                <ModelRow
                  key={modelRefKey(ref)}
                  model={info}
                  selected={
                    !currentExternal &&
                    currentRef !== null &&
                    modelRefsEqual(ref, currentRef)
                  }
                  favorite={favoriteModels.some((item) =>
                    modelRefsEqual(item, ref),
                  )}
                  showProviderIcon={effectiveActiveProvider === null}
                  onPick={() => {
                    if (persistedExternal) newSession();
                    setDraftExternalAgent(null);
                    setSelected(ref);
                  }}
                  onToggleFavorite={() => void toggleFavoriteModel(ref)}
                />
              ))
            )}
          </div>
        </div>
      </DropdownMenuContent>
      <PermissionModeDropdown />
    </DropdownMenu>
  );
}

function TabButton({
  label,
  icon,
  active,
  count,
  onClick,
}: {
  label: string;
  icon: typeof AiBookIcon;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors",
        active
          ? "bg-interactive-active text-foreground"
          : "text-muted-foreground hover:bg-interactive-hover hover:text-foreground",
      )}
    >
      <HugeiconsIcon icon={icon} size={12} strokeWidth={1.75} />
      {label}
      {count != null ? (
        <span className="rounded-full bg-muted/60 px-1.5 text-[9.5px] tabular-nums text-muted-foreground">
          {count}
        </span>
      ) : null}
    </button>
  );
}

function ProviderPill({
  icon,
  provider,
  title,
  active,
  muted,
  onClick,
}: {
  icon?: typeof AiBookIcon;
  provider?: ProviderId;
  title: string;
  active: boolean;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "relative mx-auto flex size-8 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-interactive-active text-foreground after:absolute after:right-0 after:top-1.5 after:bottom-1.5 after:w-[2px] after:rounded-full after:bg-primary after:content-['']"
          : muted
            ? "text-muted-foreground/50 hover:bg-interactive-hover hover:text-foreground"
            : "text-muted-foreground hover:bg-interactive-hover hover:text-foreground",
      )}
    >
      {provider ? (
        <ProviderIcon provider={provider} size={16} />
      ) : icon ? (
        <HugeiconsIcon icon={icon} size={16} strokeWidth={1.5} />
      ) : null}
    </button>
  );
}

function ProviderHeader({ providerId }: { providerId: ProviderId }) {
  const p = PROVIDERS.find((x) => x.id === providerId);
  if (!p) return null;
  return (
    <div className="flex items-center gap-1.5 px-3 pt-1 pb-1.5 text-[11px] font-medium tracking-tight text-muted-foreground">
      <ProviderIcon provider={p.id} size={13} />
      <span>{p.label}</span>
    </div>
  );
}

function ModelRow({
  model,
  selected,
  favorite,
  showProviderIcon,
  onPick,
  onToggleFavorite,
}: {
  model: ResolvedModel;
  selected: boolean;
  favorite: boolean;
  showProviderIcon: boolean;
  onPick: () => void;
  onToggleFavorite: () => void;
}) {
  const { t } = useTranslation("ai");
  return (
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault();
        onPick();
      }}
      className={cn(
        "group mx-1 my-0.5 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
        selected ? "bg-interactive-active text-foreground" : "text-foreground",
      )}
    >
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggleFavorite();
        }}
        title={favorite ? t("statusBar.unfavorite") : t("statusBar.favorite")}
        className={cn(
          "shrink-0 rounded p-0.5 transition-colors",
          favorite
            ? "text-amber-500"
            : "text-muted-foreground/40 hover:text-amber-500",
        )}
      >
        <HugeiconsIcon
          icon={StarIcon}
          size={12}
          strokeWidth={favorite ? 2 : 1.75}
          className={favorite ? "fill-amber-500" : ""}
        />
      </button>

      {showProviderIcon ? (
        <ProviderIcon
          provider={model.provider}
          size={13}
          className="shrink-0 text-muted-foreground"
        />
      ) : null}

      <span className="min-w-0 flex-1 truncate whitespace-nowrap text-[12px] font-medium leading-none">
        {model.label}
      </span>

      {selected ? (
        <HugeiconsIcon
          icon={Tick01Icon}
          size={13}
          strokeWidth={2}
          className="shrink-0 text-foreground"
        />
      ) : null}
    </DropdownMenuItem>
  );
}

function IconBtn({
  title,
  onClick,
  disabled,
  className,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "size-6 rounded-md text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      {children}
    </Button>
  );
}

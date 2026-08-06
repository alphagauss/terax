/**
 * 本文件实现 AI 侧边栏 Composer 及其模型选择界面。
 * 负责输入、上下文标签、模型筛选和发送控制。
 */

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  Add01Icon,
  AiBookIcon,
  AppleIcon,
  ArrowDown01Icon,
  ArrowUpIcon,
  BrainIcon,
  ChatGptIcon,
  ClaudeIcon,
  Clock01Icon,
  CoinsDollarIcon,
  ComputerIcon,
  CpuIcon,
  DeepseekIcon,
  FavouriteIcon,
  FlashIcon,
  GlobeIcon,
  GoogleGeminiIcon,
  Grok02Icon,
  HandIcon,
  Mic01Icon,
  MistralIcon,
  PlugIcon,
  Search01Icon,
  SecurityWarningIcon,
  ServerStack01Icon,
  Settings01Icon,
  StarIcon,
  StopCircleIcon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  compatModelIdForEndpoint,
  getCompatModelInfo,
  getModel,
  isCompatModelId,
  MODELS,
  type ModelCapabilities,
  type ModelId,
  type ModelInfo,
  PROVIDERS,
  type ProviderId,
  providerNeedsKey,
  STT_PROVIDER_LABELS,
} from "../config";
import { ACCEPTED_FILES, useComposer } from "../lib/composer";
import { toggleFavoriteModel } from "../lib/modelPrefs";
import { useChatStore } from "../store/chatStore";
import { AiComposerInput } from "./AiComposerInput";
import { ChipsRow } from "./ChipsRow";

const PROVIDER_ICON = {
  openai: ChatGptIcon,
  anthropic: ClaudeIcon,
  google: GoogleGeminiIcon,
  xai: Grok02Icon,
  cerebras: CpuIcon,
  groq: FlashIcon,
  deepseek: DeepseekIcon,
  mistral: MistralIcon,
  openrouter: GlobeIcon,
  "openai-compatible": PlugIcon,
  lmstudio: ComputerIcon,
  mlx: AppleIcon,
  ollama: ServerStack01Icon,
} as const satisfies Record<ProviderId, typeof ChatGptIcon>;

/**
 * AI 侧栏输入组件。
 * 负责输入附件、模型和进程内权限模式选择，以及发送和停止操作。
 */
export function AiSidebarComposer() {
  const { t } = useTranslation("ai");
  const c = useComposer();
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="relative z-10 shrink-0 px-3 pb-3">
      <div className="flex flex-col gap-2 rounded-2xl border border-border/60 bg-accent/80 p-2.5 shadow-lg shadow-background/60">
        <input
          ref={fileInputRef}
          type="file"
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

        <div className="flex min-w-0 items-center gap-0.5">
          <IconBtn
            title={t("statusBar.attachFileOrImage")}
            onClick={() => fileInputRef.current?.click()}
            disabled={c.isBusy}
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
              disabled={c.isBusy || c.voice.transcribing || !c.voice.hasKey}
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

          {c.isBusy ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={c.stop}
              className="size-7"
              aria-label={t("statusBar.stop")}
              title={t("statusBar.stop")}
            >
              <HugeiconsIcon
                icon={StopCircleIcon}
                size={14}
                strokeWidth={1.75}
              />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              onClick={c.submit}
              disabled={!c.canSend}
              className="size-7 rounded-full"
              aria-label={t("statusBar.send")}
              title={t("statusBar.send")}
            >
              <HugeiconsIcon icon={ArrowUpIcon} size={14} strokeWidth={1.75} />
            </Button>
          )}
        </div>
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
  const mode = useChatStore((s) => s.permissionMode);
  const setMode = useChatStore((s) => s.setPermissionMode);
  const activeIcon = mode === "ask" ? HandIcon : SecurityWarningIcon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "my-1 h-5.5 shrink-0 gap-1 rounded-md px-1.5 text-xs hover:bg-accent focus-visible:border-transparent focus-visible:ring-0",
            mode === "full-access"
              ? "text-amber-600! dark:text-amber-400!"
              : "text-foreground!",
          )}
          title={t(`statusBar.permissionMode.${mode}`)}
        >
          <HugeiconsIcon icon={activeIcon} size={13} strokeWidth={1.75} />
          <span>{t(`statusBar.permissionMode.${mode}`)}</span>
          <HugeiconsIcon icon={ArrowDown01Icon} size={11} strokeWidth={2} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-44 rounded-2xl p-1"
      >
        {PERMISSION_MODES.map((item) => (
          <DropdownMenuItem
            key={item.id}
            onSelect={() => setMode(item.id)}
            className={cn(
              "gap-2 rounded-xl px-2.5 py-1.5 text-xs",
              item.id === "full-access"
                ? "text-amber-600! **:text-amber-600! dark:text-amber-400! dark:**:text-amber-400!"
                : "text-foreground! **:text-foreground!",
            )}
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

function ModelDropdown() {
  const { t } = useTranslation("ai");
  const selected = useChatStore((s) => s.selectedModelId);
  const apiKeys = useChatStore((s) => s.apiKeys);
  const setSelected = useChatStore((s) => s.setSelectedModelId);
  const favoriteIds = usePreferencesStore((s) => s.favoriteModelIds);
  const recentIds = usePreferencesStore((s) => s.recentModelIds);
  const customEndpoints = usePreferencesStore((s) => s.customEndpoints);
  const current = isCompatModelId(selected)
    ? getCompatModelInfo(selected, customEndpoints)
    : getModel(selected as ModelId);
  const [search, setSearch] = useState("");
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const inputRef = useRef<HTMLInputElement>(null);
  const currentProviderHasKey = isCompatModelId(selected)
    ? true
    : providerNeedsKey(current.provider)
      ? !!apiKeys[current.provider]
      : true;

  const hasKeyFor = useCallback(
    (id: ProviderId) => (providerNeedsKey(id) ? !!apiKeys[id] : true),
    [apiKeys],
  );

  const epModelInfos = useMemo(() => {
    return customEndpoints.map((ep) =>
      getCompatModelInfo(compatModelIdForEndpoint(ep.id), customEndpoints),
    );
  }, [customEndpoints]);

  const sortedProviders = useMemo(() => {
    const configured: (typeof PROVIDERS)[number][] = [];
    const unconfigured: (typeof PROVIDERS)[number][] = [];
    for (const p of PROVIDERS) {
      if (p.id === "openai-compatible") continue;
      (hasKeyFor(p.id) ? configured : unconfigured).push(p);
    }
    return { configured, unconfigured };
  }, [hasKeyFor]);

  const allModels = useMemo(() => [...MODELS, ...epModelInfos], [epModelInfos]);

  const COMPAT_PROVIDER_ID = "__compat__";

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let pool: readonly ModelInfo[] = allModels;
    if (tab === "favorites") {
      pool = pool.filter((m) => favoriteIds.includes(m.id));
    } else if (tab === "recent") {
      const order = new Map(recentIds.map((id, i) => [id, i]));
      pool = pool
        .filter((m) => order.has(m.id))
        .slice()
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }
    if (activeProvider === COMPAT_PROVIDER_ID) {
      pool = pool.filter((m) => isCompatModelId(m.id));
    } else if (activeProvider !== null) {
      pool = pool.filter((m) => m.provider === activeProvider);
    }
    if (q) {
      pool = pool.filter(
        (m) =>
          m.label.toLowerCase().includes(q) ||
          m.hint.toLowerCase().includes(q) ||
          m.description.toLowerCase().includes(q) ||
          m.provider.includes(q) ||
          (m.tags?.some((t) => t.includes(q)) ?? false),
      );
    }
    return pool;
  }, [activeProvider, allModels, favoriteIds, recentIds, search, tab]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-5.5 gap-1 rounded-md px-1.5 my-1 text-xs hover:bg-accent hover:text-foreground",
            currentProviderHasKey
              ? "text-muted-foreground"
              : "text-amber-600 dark:text-amber-400",
          )}
          title={
            currentProviderHasKey
              ? t("statusBar.modelTitle", { label: current.label })
              : t("statusBar.modelNoKey", { label: current.label })
          }
        >
          {current.label}
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
        className="w-[28rem] p-0 overflow-hidden rounded-xl border border-border/70 shadow-xl"
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
            className="shrink-0 text-muted-foreground/70"
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
            count={favoriteIds.length || undefined}
          />
          <TabButton
            label={t("statusBar.tabRecent")}
            icon={Clock01Icon}
            active={tab === "recent"}
            onClick={() => setTab("recent")}
            count={recentIds.length || undefined}
          />
        </div>

        <div className="flex max-h-104 min-h-0">
          {/* 已配置的提供方优先，未配置项弱化显示。 */}
          <div className="flex w-11 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border/70 bg-muted/20 py-1.5">
            <ProviderPill
              icon={AiBookIcon}
              title={t("statusBar.allProviders")}
              active={activeProvider === null}
              onClick={() => setActiveProvider(null)}
            />
            {[
              ...sortedProviders.configured,
              ...sortedProviders.unconfigured,
            ].map((p) => (
              <ProviderPill
                key={p.id}
                icon={PROVIDER_ICON[p.id]}
                title={
                  hasKeyFor(p.id)
                    ? p.label
                    : t("statusBar.notConfigured", { label: p.label })
                }
                active={activeProvider === p.id}
                muted={!hasKeyFor(p.id)}
                onClick={() => setActiveProvider(p.id)}
              />
            ))}
            {customEndpoints.length > 0 && (
              <ProviderPill
                icon={PlugIcon}
                title={t("statusBar.openaiCompatible")}
                active={activeProvider === COMPAT_PROVIDER_ID}
                onClick={() => setActiveProvider(COMPAT_PROVIDER_ID)}
              />
            )}
          </div>

          {/* Models list */}
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {activeProvider === COMPAT_PROVIDER_ID && (
              <div className="flex items-center gap-1.5 px-3 pt-1 pb-1.5 text-[11px] font-medium tracking-tight text-muted-foreground/90">
                <HugeiconsIcon icon={PlugIcon} size={13} strokeWidth={1.75} />
                <span>{t("statusBar.openaiCompatible")}</span>
              </div>
            )}
            {activeProvider !== null &&
            activeProvider !== COMPAT_PROVIDER_ID ? (
              <ProviderHeader providerId={activeProvider as ProviderId} />
            ) : null}
            {activeProvider !== null &&
            activeProvider !== COMPAT_PROVIDER_ID &&
            !hasKeyFor(activeProvider as ProviderId) ? (
              <ProviderConfigureCTA providerId={activeProvider as ProviderId} />
            ) : null}
            {filtered.length === 0 ? (
              <div className="flex items-center justify-center px-4 py-10 text-xs text-muted-foreground">
                {tab === "favorites"
                  ? t("statusBar.noFavorites")
                  : tab === "recent"
                    ? t("statusBar.noRecent")
                    : t("statusBar.noMatch")}
              </div>
            ) : (
              filtered.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  selected={m.id === selected}
                  hasKey={isCompatModelId(m.id) || hasKeyFor(m.provider)}
                  favorite={favoriteIds.includes(m.id)}
                  showProviderIcon={activeProvider === null}
                  onPick={() => {
                    if (!isCompatModelId(m.id) && !hasKeyFor(m.provider)) {
                      void openSettingsWindow("models");
                      return;
                    }
                    setSelected(m.id);
                  }}
                  onToggleFavorite={() => void toggleFavoriteModel(m.id)}
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
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
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
  title,
  active,
  muted,
  onClick,
}: {
  icon: typeof AiBookIcon;
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
          ? "bg-accent text-foreground after:absolute after:right-0 after:top-1.5 after:bottom-1.5 after:w-[2px] after:rounded-full after:bg-primary after:content-['']"
          : muted
            ? "text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground"
            : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
    >
      <HugeiconsIcon icon={icon} size={16} strokeWidth={1.5} />
    </button>
  );
}

function ProviderHeader({ providerId }: { providerId: ProviderId }) {
  const p = PROVIDERS.find((x) => x.id === providerId);
  if (!p) return null;
  return (
    <div className="flex items-center gap-1.5 px-3 pt-1 pb-1.5 text-[11px] font-medium tracking-tight text-muted-foreground/90">
      <HugeiconsIcon icon={PROVIDER_ICON[p.id]} size={13} strokeWidth={1.75} />
      <span>{p.label}</span>
    </div>
  );
}

function ProviderConfigureCTA({ providerId }: { providerId: ProviderId }) {
  const { t } = useTranslation("ai");
  const p = PROVIDERS.find((x) => x.id === providerId);
  if (!p) return null;
  return (
    <button
      type="button"
      onClick={() => void openSettingsWindow("models")}
      className="group mx-2 mb-1 flex w-[calc(100%-1rem)] items-center gap-2 rounded-md border border-dashed border-border/70 bg-muted/20 px-3 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground"
    >
      <HugeiconsIcon icon={Settings01Icon} size={13} strokeWidth={1.75} />
      <span className="flex-1 truncate">
        {t("statusBar.configureCta", { label: p.label })}
      </span>
      <span className="shrink-0 text-[10px] underline-offset-2 group-hover:underline">
        {t("statusBar.open")}
      </span>
    </button>
  );
}

function ModelRow({
  model,
  selected,
  hasKey,
  favorite,
  showProviderIcon,
  onPick,
  onToggleFavorite,
}: {
  model: ModelInfo;
  selected: boolean;
  hasKey: boolean;
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
        selected ? "bg-accent/60 text-foreground" : "text-foreground/85",
        !hasKey && "opacity-60",
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
        <HugeiconsIcon
          icon={PROVIDER_ICON[model.provider]}
          size={13}
          strokeWidth={1.5}
          className="shrink-0 text-muted-foreground/70"
        />
      ) : null}

      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="shrink-0 text-[12px] font-medium leading-none">
          {model.label}
        </span>
        <span className="truncate text-[10.5px] leading-none text-muted-foreground">
          {model.description}
        </span>
      </div>

      <CapabilityBars caps={model.capabilities} />

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

function CapabilityBars({ caps }: { caps: ModelCapabilities }) {
  const { t } = useTranslation("ai");
  return (
    <div className="ml-auto flex items-center gap-1.5">
      <CapBar
        icon={BrainIcon}
        value={caps.intelligence}
        label={t("statusBar.intelligence")}
      />
      <CapBar
        icon={FlashIcon}
        value={caps.speed}
        label={t("statusBar.speed")}
      />
      <CapBar
        icon={CoinsDollarIcon}
        value={caps.cost}
        label={t("statusBar.affordability")}
      />
    </div>
  );
}

function CapBar({
  icon,
  value,
  label,
}: {
  icon: typeof AiBookIcon;
  value: number;
  label: string;
}) {
  const { t } = useTranslation("ai");
  return (
    <span
      className="flex items-center gap-0.5"
      title={t("statusBar.capBarTitle", { label, value })}
    >
      <HugeiconsIcon
        icon={icon}
        size={10}
        strokeWidth={1.75}
        className="text-muted-foreground/60"
      />
      <span className="flex items-center gap-px">
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className={cn(
              "h-2 w-[2px] rounded-full",
              i <= value ? "bg-foreground/70" : "bg-foreground/15",
            )}
          />
        ))}
      </span>
    </span>
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

/**
 * 本文件呈现主 Agent、Subagent、自动补全、提供商和语音输入设置。
 * 负责绑定偏好与密钥状态，并在 Provider 配置变化时同步关联模型引用。
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/controls/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  builtinProviderId,
  DEFAULT_MODEL_REF,
  getAutocompleteEligibleModels,
  getProvider,
  MODELS,
  type ModelInfo,
  type ModelRef,
  modelRefForProvider,
  modelRefKey,
  modelRefsEqual,
  PROVIDERS,
  type ProviderInstance,
  type ProviderId,
  type ProviderInfo,
  providerNeedsKey,
  resolveModel,
  STT_PROVIDER_LABELS,
  type SttProvider,
  tryResolveModel,
  WHISPERCPP_DEFAULT_BASE_URL,
} from "@/modules/ai/config";
import {
  clearProviderInstanceKey,
  clearKey,
  getAllProviderInstanceKeys,
  getAllKeys,
  type ProviderInstanceKeys,
  setProviderInstanceKey,
  setKey,
} from "@/modules/ai/lib/keyring";
import { buildModelReferencePatch } from "@/modules/ai/lib/modelPrefs";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type AutocompleteTrigger,
  MAX_CONCURRENT_SUBAGENTS_MAX,
  MAX_CONCURRENT_SUBAGENTS_MIN,
  type ModelSettingsPatch,
  setAutocompleteEnabled,
  setAutocompleteModel,
  setAutocompleteTrigger,
  setDefaultModel,
  setDefaultSubagentModel,
  setGroqSttModel,
  setMaxConcurrentSubagents,
  setModelSettings,
  setSttProvider,
  setWhispercppBaseURL,
} from "@/modules/settings/store";
import { getBindingTokens, SHORTCUTS } from "@/modules/shortcuts/shortcuts";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  ChevronDown,
  Mic01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProviderIcon } from "../components/ProviderIcon";
import { ProviderKeyCard } from "../components/ProviderKeyCard";
import { SectionHeader } from "../components/SectionHeader";

type KeysMap = Record<ProviderId, string | null>;
type ProviderInstanceUpdate = Partial<
  Pick<ProviderInstance, "name" | "baseURL" | "contextLimit">
>;

// 模型文案按模型名存放；关闭分隔符解析后，动态模型可直接回退到原始文本。
type TFn = ReturnType<typeof useTranslation>["t"];
const modelHint = (t: TFn, m: { id: string; hint: string }): string =>
  t(`modelHint.${m.id}`, {
    ns: "aiModels",
    keySeparator: false,
    nsSeparator: false,
    defaultValue: m.hint,
  });
const modelDesc = (t: TFn, m: { id: string; description: string }): string =>
  t(`modelDesc.${m.id}`, {
    ns: "aiModels",
    keySeparator: false,
    nsSeparator: false,
    defaultValue: m.description,
  });
const sttLabel = (t: TFn, p: SttProvider): string =>
  t(`sttProvider.${p}`, {
    ns: "aiModels",
    keySeparator: false,
    nsSeparator: false,
    defaultValue: STT_PROVIDER_LABELS[p],
  });

const isLocalProvider = (id: ProviderId): boolean => !providerNeedsKey(id);

type LocalMeta = {
  urlPlaceholder: string;
  modelPlaceholder: string;
  description: string;
  modelHint: React.ReactNode;
};

const getLocalMeta = (t: TFn): Partial<Record<ProviderId, LocalMeta>> => ({
  lmstudio: {
    urlPlaceholder: "http://localhost:1234/v1",
    modelPlaceholder: "qwen2.5-coder-7b-instruct",
    description: t("models.local.lmstudio.description"),
    modelHint: t("models.local.lmstudio.modelHint"),
  },
  mlx: {
    urlPlaceholder: "http://127.0.0.1:8080/v1",
    modelPlaceholder: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
    description: t("models.local.mlx.description"),
    modelHint: t("models.local.mlx.modelHint"),
  },
  ollama: {
    urlPlaceholder: "http://localhost:11434/v1",
    modelPlaceholder: "qwen2.5-coder:7b",
    description: t("models.local.ollama.description"),
    modelHint: t("models.local.ollama.modelHint"),
  },
  openrouter: {
    urlPlaceholder: "",
    modelPlaceholder: "anthropic/claude-sonnet-5, openai/gpt-5.6, …",
    description: t("models.local.openrouter.description"),
    modelHint: t("models.local.openrouter.modelHint"),
  },
});

/** 模型设置主区域，组合 Agent 默认值、Subagent 并发及云端、本地和语音提供商配置。 */
export function ModelsSection() {
  const { t } = useTranslation();
  const localMeta = getLocalMeta(t);
  const [keys, setKeys] = useState<KeysMap | null>(null);
  const [customProviderKeys, setCustomProviderKeys] =
    useState<ProviderInstanceKeys>({});
  const [adding, setAdding] = useState<Set<ProviderId>>(new Set());

  const defaultModel = usePreferencesStore((s) => s.defaultModel);
  const defaultSubagentModel = usePreferencesStore(
    (s) => s.defaultSubagentModel,
  );
  const maxConcurrentSubagents = usePreferencesStore(
    (s) => s.maxConcurrentSubagents,
  );
  const providerModels = usePreferencesStore((s) => s.providerModels);
  const lmstudioBaseURL = usePreferencesStore((s) => s.lmstudioBaseURL);
  const mlxBaseURL = usePreferencesStore((s) => s.mlxBaseURL);
  const ollamaBaseURL = usePreferencesStore((s) => s.ollamaBaseURL);
  const customProviders = usePreferencesStore((s) => s.customProviders);

  useEffect(() => {
    void getAllKeys().then(setKeys);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getAllProviderInstanceKeys(customProviders).then((providerKeys) => {
      if (!cancelled) setCustomProviderKeys(providerKeys);
    });
    return () => {
      cancelled = true;
    };
  }, [customProviders]);

  const onSaveKey = async (provider: ProviderId, value: string) => {
    await setKey(provider, value);
    setKeys((prev) => (prev ? { ...prev, [provider]: value } : prev));
  };

  const onClearKey = async (provider: ProviderId) => {
    await clearKey(provider);
    setKeys((prev) => (prev ? { ...prev, [provider]: null } : prev));
  };

  const onSaveCustomProviderKey = async (providerId: string, value: string) => {
    await setProviderInstanceKey(providerId, value);
    setCustomProviderKeys((prev) => ({ ...prev, [providerId]: value }));
  };

  const onClearCustomProviderKey = async (providerId: string) => {
    await clearProviderInstanceKey(providerId);
    setCustomProviderKeys((prev) => ({ ...prev, [providerId]: null }));
  };

  const addCustomProvider = async () => {
    const provider: ProviderInstance = {
      id: `custom:${crypto.randomUUID()}`,
      protocol: "openai-compatible",
      name: "",
      baseURL: "",
      contextLimit: 128_000,
    };
    await setModelSettings({
      customProviders: [...customProviders, provider],
    });
  };

  /** 同步替换设置引用和当前聊天选择，自动切换不计入最近使用。 */
  const prepareReferenceUpdate = (
    matches: (model: ModelRef) => boolean,
    replacement: ModelRef | null,
  ): ModelSettingsPatch => {
    const prefs = usePreferencesStore.getState();
    const patch = buildModelReferencePatch(prefs, matches, replacement);
    const chat = useChatStore.getState();
    if (matches(chat.selectedModel)) {
      const fallback = matches(prefs.defaultModel)
        ? DEFAULT_MODEL_REF
        : prefs.defaultModel;
      chat.setSelectedModel(replacement ?? fallback, false);
    }
    return patch;
  };

  const updateCustomProvider = async (
    id: string,
    patch: ProviderInstanceUpdate,
  ) => {
    const previous = customProviders.find((provider) => provider.id === id);
    if (!previous) return;
    const nextProvider = { ...previous, ...patch };
    const nextProviders = customProviders.map((provider) =>
      provider.id === id ? nextProvider : provider,
    );
    const wasConfigured =
      !!previous.baseURL.trim() && !!providerModels[id]?.trim();
    const isConfigured =
      !!nextProvider.baseURL.trim() && !!providerModels[id]?.trim();
    const referencePatch =
      wasConfigured && !isConfigured
        ? prepareReferenceUpdate((model) => model.providerId === id, null)
        : {};
    await setModelSettings({
      ...referencePatch,
      customProviders: nextProviders,
    });
  };

  const removeCustomProvider = async (id: string) => {
    const removed = customProviders.find((provider) => provider.id === id);
    if (!removed) return;
    const remaining = customProviders.filter((provider) => provider.id !== id);
    const referencePatch = prepareReferenceUpdate(
      (model) => model.providerId === removed.id,
      null,
    );
    const nextProviderModels = { ...providerModels };
    delete nextProviderModels[id];
    await setModelSettings({
      ...referencePatch,
      customProviders: remaining,
      providerModels: nextProviderModels,
    });
    await clearProviderInstanceKey(id);
    setCustomProviderKeys((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  /** 更新自由模型 Provider 的模型名，并原子替换所有关联引用。 */
  const updateConfiguredModel = async (providerId: string, value: string) => {
    const prefs = usePreferencesStore.getState();
    const previousModelId = prefs.providerModels[providerId] ?? "";
    if (previousModelId === value) return;
    const nextProviderModels = { ...prefs.providerModels };
    if (value.trim()) nextProviderModels[providerId] = value;
    else delete nextProviderModels[providerId];

    let referencePatch: ModelSettingsPatch = {};
    if (!value.trim()) {
      referencePatch = prepareReferenceUpdate(
        (model) => model.providerId === providerId,
        null,
      );
    } else if (previousModelId.trim()) {
      const previousModel = { providerId, modelId: previousModelId };
      const nextModel = { providerId, modelId: value };
      referencePatch = prepareReferenceUpdate(
        (model) => modelRefsEqual(model, previousModel),
        nextModel,
      );
    }
    await setModelSettings({
      ...referencePatch,
      providerModels: nextProviderModels,
    });
  };

  /** 更新本地 Provider 地址；清空地址时同步移除已不可用的模型引用。 */
  const updateLocalBaseURL = async (
    provider: "lmstudio" | "mlx" | "ollama",
    value: string,
  ) => {
    const prefs = usePreferencesStore.getState();
    const previousBaseURL =
      provider === "lmstudio"
        ? prefs.lmstudioBaseURL
        : provider === "mlx"
          ? prefs.mlxBaseURL
          : prefs.ollamaBaseURL;
    const baseURLPatch: ModelSettingsPatch =
      provider === "lmstudio"
        ? { lmstudioBaseURL: value }
        : provider === "mlx"
          ? { mlxBaseURL: value }
          : { ollamaBaseURL: value };
    if (previousBaseURL === value) return;

    const referencePatch = value.trim()
      ? {}
      : prepareReferenceUpdate(
          (model) => model.providerId === builtinProviderId(provider),
          null,
        );
    await setModelSettings({ ...referencePatch, ...baseURLPatch });
  };

  const localConfig = (id: ProviderId): LocalConfig | null => {
    switch (id) {
      case "lmstudio":
        return {
          baseURL: lmstudioBaseURL,
          modelId: providerModels[builtinProviderId(id)] ?? "",
          setBaseURL: (value) => updateLocalBaseURL("lmstudio", value),
          setModelId: (value) =>
            updateConfiguredModel(builtinProviderId(id), value),
        };
      case "mlx":
        return {
          baseURL: mlxBaseURL,
          modelId: providerModels[builtinProviderId(id)] ?? "",
          setBaseURL: (value) => updateLocalBaseURL("mlx", value),
          setModelId: (value) =>
            updateConfiguredModel(builtinProviderId(id), value),
        };
      case "ollama":
        return {
          baseURL: ollamaBaseURL,
          modelId: providerModels[builtinProviderId(id)] ?? "",
          setBaseURL: (value) => updateLocalBaseURL("ollama", value),
          setModelId: (value) =>
            updateConfiguredModel(builtinProviderId(id), value),
        };
      case "openrouter":
        return {
          baseURL: "",
          modelId: providerModels[builtinProviderId(id)] ?? "",
          setBaseURL: async () => {},
          setModelId: (value) =>
            updateConfiguredModel(builtinProviderId(id), value),
          noBaseURL: true,
        };
      default:
        return null;
    }
  };

  const isConfigured = (id: ProviderId): boolean => {
    const cfg = localConfig(id);
    if (id === "openrouter") return !!keys?.[id] && !!cfg?.modelId.trim();
    if (!isLocalProvider(id)) return !!keys?.[id];
    if (!cfg) return false;
    return !!cfg.baseURL.trim() && !!cfg.modelId.trim();
  };

  if (!keys) {
    return (
      <div className="text-[12px] text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  const configuredIds = new Set(
    PROVIDERS.filter((p) => isConfigured(p.id)).map((p) => p.id),
  );
  const visibleIds = new Set<ProviderId>(configuredIds);
  for (const id of adding) visibleIds.add(id);
  const visibleProviders = PROVIDERS.filter(
    (p) => p.id !== "openai-compatible" && visibleIds.has(p.id),
  );
  const addableProviders = PROVIDERS.filter(
    (p) => p.id !== "openai-compatible" && !visibleIds.has(p.id),
  );

  const removeProvider = async (id: ProviderId) => {
    if (id === "openrouter") {
      await updateConfiguredModel(builtinProviderId(id), "");
      await onClearKey(id);
    } else if (isLocalProvider(id)) {
      const cfg = localConfig(id);
      if (cfg) {
        await cfg.setModelId("");
      }
    } else {
      const providerId = builtinProviderId(id);
      const referencePatch = prepareReferenceUpdate(
        (model) => model.providerId === providerId,
        null,
      );
      await setModelSettings(referencePatch);
      await onClearKey(id);
    }
    setAdding((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const addProvider = (id: ProviderId) => {
    setAdding((prev) => new Set(prev).add(id));
  };

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title={t("models.header.title")}
        description={t("models.header.description")}
      />

      <DefaultsBlock
        defaultModel={defaultModel}
        defaultSubagentModel={defaultSubagentModel}
        maxConcurrentSubagents={maxConcurrentSubagents}
        configuredIds={configuredIds}
        keys={keys}
        customProviders={customProviders}
      />

      <VoiceBlock />

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Label>{t("models.providers.label")}</Label>
          <AddProviderMenu
            providers={addableProviders}
            onAdd={addProvider}
            onAddCustom={addCustomProvider}
          />
        </div>

        {visibleProviders.length === 0 && customProviders.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/40 px-4 py-8 text-center">
            <p className="text-[12px] text-muted-foreground">
              {t("models.providers.emptyTitle")}
            </p>
            <p className="mt-0.5 text-[10.5px] text-muted-foreground">
              {t("models.providers.emptyHint")}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleProviders.map((provider) => {
              if (
                provider.id === "openrouter" ||
                isLocalProvider(provider.id)
              ) {
                const config = localConfig(provider.id);
                const meta = localMeta[provider.id];
                if (!config || !meta) return null;
                return (
                  <LocalProviderCard
                    key={provider.id}
                    provider={provider}
                    configured={configuredIds.has(provider.id)}
                    config={config}
                    meta={meta}
                    providerKey={keys[provider.id]}
                    onSaveKey={(value) => onSaveKey(provider.id, value)}
                    onClearKey={() => onClearKey(provider.id)}
                    onRemove={() => void removeProvider(provider.id)}
                  />
                );
              }
              return (
                <ProviderKeyCard
                  key={provider.id}
                  provider={provider}
                  currentKey={keys[provider.id]}
                  onSave={(value) => onSaveKey(provider.id, value)}
                  onClear={() => onClearKey(provider.id)}
                  onRemove={() => void removeProvider(provider.id)}
                />
              );
            })}
            {customProviders.map((provider) => (
              <CustomProviderCard
                key={provider.id}
                provider={provider}
                modelId={providerModels[provider.id] ?? ""}
                providerKey={customProviderKeys[provider.id] ?? null}
                onSaveKey={(value) =>
                  onSaveCustomProviderKey(provider.id, value)
                }
                onClearKey={() => onClearCustomProviderKey(provider.id)}
                onUpdate={(patch) => updateCustomProvider(provider.id, patch)}
                onUpdateModel={(value) =>
                  updateConfiguredModel(provider.id, value)
                }
                onRemove={() => removeCustomProvider(provider.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type LocalConfig = {
  baseURL: string;
  modelId: string;
  setBaseURL: (v: string) => Promise<void>;
  setModelId: (v: string) => Promise<void>;
  noBaseURL?: boolean;
};

function AddProviderMenu({
  providers,
  onAdd,
  onAddCustom,
}: {
  providers: readonly ProviderInfo[];
  onAdd: (id: ProviderId) => void;
  onAddCustom: () => void;
}) {
  const { t } = useTranslation();
  const cloud = providers.filter((p) => !isLocalProvider(p.id));
  const local = providers.filter(
    (p) => isLocalProvider(p.id) && p.id !== "openai-compatible",
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2.5 text-[11px]"
        >
          <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
          {t("models.providers.addProvider")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-55 p-1">
        {cloud.length > 0 ? (
          <>
            <DropdownMenuLabel className="px-2 text-[10px] tracking-wide text-muted-foreground uppercase">
              {t("models.providers.cloud")}
            </DropdownMenuLabel>
            {cloud.map((p) => (
              <ProviderMenuItem key={p.id} provider={p} onAdd={onAdd} />
            ))}
          </>
        ) : null}
        <DropdownMenuLabel className="px-2 text-[10px] tracking-wide text-muted-foreground uppercase">
          {t("models.providers.localCustom")}
        </DropdownMenuLabel>
        {local.map((p) => (
          <ProviderMenuItem key={p.id} provider={p} onAdd={onAdd} />
        ))}
        <DropdownMenuItem
          onSelect={() => onAddCustom()}
          className="flex items-center gap-2 text-[12px]"
        >
          <ProviderIcon provider="openai-compatible" size={13} />
          <span>{t("models.providers.openaiCompatible")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProviderMenuItem({
  provider,
  onAdd,
}: {
  provider: ProviderInfo;
  onAdd: (id: ProviderId) => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={() => onAdd(provider.id)}
      className="flex items-center gap-2 text-[12px]"
    >
      <ProviderIcon provider={provider.id} size={13} />
      <span>{provider.label}</span>
    </DropdownMenuItem>
  );
}

function DefaultsBlock({
  defaultModel,
  defaultSubagentModel,
  maxConcurrentSubagents,
  configuredIds,
  keys,
  customProviders,
}: {
  defaultModel: ModelRef;
  defaultSubagentModel: ModelRef | null;
  maxConcurrentSubagents: number;
  configuredIds: Set<ProviderId>;
  keys: KeysMap;
  customProviders: readonly ProviderInstance[];
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <Label>{t("models.defaults.label")}</Label>
      <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
        <FieldRow label={t("models.defaults.chatModel")}>
          <DefaultModelPicker
            model={defaultModel}
            configuredIds={configuredIds}
            customProviders={customProviders}
            onSelect={(model) => {
              if (model) void setDefaultModel(model);
            }}
          />
        </FieldRow>
        <FieldRow label={t("models.defaults.subagentModel")}>
          <DefaultModelPicker
            model={defaultSubagentModel}
            configuredIds={configuredIds}
            customProviders={customProviders}
            inheritLabel={t("models.defaults.followChatModel")}
            onSelect={(model) => void setDefaultSubagentModel(model)}
          />
        </FieldRow>
        <FieldRow label={t("models.defaults.subagentConcurrency")}>
          <Select
            value={String(maxConcurrentSubagents)}
            onValueChange={(value) =>
              void setMaxConcurrentSubagents(Number(value))
            }
          >
            <SelectTrigger className="h-8 w-full text-[11.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from(
                {
                  length:
                    MAX_CONCURRENT_SUBAGENTS_MAX -
                    MAX_CONCURRENT_SUBAGENTS_MIN +
                    1,
                },
                (_, index) => MAX_CONCURRENT_SUBAGENTS_MIN + index,
              ).map((value) => (
                <SelectItem key={value} value={String(value)}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>
        <AutocompleteRow
          keys={keys}
          configuredIds={configuredIds}
          customProviders={customProviders}
        />
      </div>
    </div>
  );
}

/** 渲染可选继承项的默认模型选择器，只列出已经配置的 provider。 */
function DefaultModelPicker({
  model,
  configuredIds,
  customProviders,
  inheritLabel,
  onSelect,
}: {
  model: ModelRef | null;
  configuredIds: Set<ProviderId>;
  customProviders: readonly ProviderInstance[];
  inheritLabel?: string;
  onSelect: (model: ModelRef | null) => void;
}) {
  const { t } = useTranslation();
  const providerModels = usePreferencesStore((s) => s.providerModels);
  const modelOptions: { ref: ModelRef; info: ModelInfo }[] = PROVIDERS.filter(
    (provider) => configuredIds.has(provider.id),
  ).flatMap<{ ref: ModelRef; info: ModelInfo }>((provider) => {
    const configured = providerModels[builtinProviderId(provider.id)]?.trim();
    if (configured) {
      const ref = modelRefForProvider(provider.id, configured);
      return [{ ref, info: resolveModel(ref) }];
    }
    return MODELS.filter((item) => item.provider === provider.id).map(
      (info) => ({
        ref: modelRefForProvider(provider.id, info.id),
        info,
      }),
    );
  });
  const customModels = customProviders.flatMap((provider) => {
    const modelId = providerModels[provider.id]?.trim();
    if (!provider.baseURL.trim() || !modelId) return [];
    const ref = { providerId: provider.id, modelId };
    return [{ ref, info: resolveModel(ref, customProviders) }];
  });
  const current = model ? tryResolveModel(model, customProviders) : null;
  const hasAny =
    inheritLabel !== undefined ||
    modelOptions.length > 0 ||
    customModels.length > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          disabled={!hasAny}
          className="h-8 flex-1 justify-between gap-2 px-2.5 text-[11.5px]"
        >
          <span className="flex items-center gap-2 truncate">
            {current ? (
              <ProviderIcon provider={current.provider} size={13} />
            ) : null}
            <span className="truncate">{current?.label ?? inheritLabel}</span>
            {current ? (
              <span className="text-muted-foreground">
                · {modelHint(t, current)}
              </span>
            ) : null}
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
        align="start"
        side="bottom"
        sideOffset={6}
        collisionPadding={12}
        className="min-w-70 p-1"
      >
        <div className="max-h-72 overflow-y-auto overscroll-contain pr-1">
          {inheritLabel ? (
            <DropdownMenuItem
              onSelect={() => onSelect(null)}
              className={cn(
                "text-[12px]",
                model === null && "bg-interactive-active",
              )}
            >
              {inheritLabel}
            </DropdownMenuItem>
          ) : null}
          {PROVIDERS.map((p) => {
            const models = modelOptions.filter(
              (option) => option.info.provider === p.id,
            );
            if (models.length === 0) return null;
            return (
              <div key={p.id} className="px-1 pt-1.5 first:pt-1">
                <div className="mb-0.5 flex items-center gap-1.5 px-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  <ProviderIcon provider={p.id} size={11} />
                  <span>{p.label}</span>
                </div>
                {models.map(({ ref, info }) => (
                  <DropdownMenuItem
                    key={modelRefKey(ref)}
                    onSelect={() => onSelect(ref)}
                    className={cn(
                      "flex items-start gap-2 text-[12px]",
                      model &&
                        modelRefsEqual(ref, model) &&
                        "bg-interactive-active",
                    )}
                  >
                    <span className="flex flex-1 flex-col">
                      <span>{info.label}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {modelDesc(t, info)}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </div>
            );
          })}
          {customModels.length > 0 ? (
            <div className="px-1 pt-1.5">
              <div className="mb-0.5 flex items-center gap-1.5 px-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                <ProviderIcon provider="openai-compatible" size={11} />
                <span>{t("models.providers.openaiCompatible")}</span>
              </div>
              {customModels.map(({ ref, info }) => (
                <DropdownMenuItem
                  key={modelRefKey(ref)}
                  onSelect={() => onSelect(ref)}
                  className={cn(
                    "flex items-start gap-2 text-[12px]",
                    model &&
                      modelRefsEqual(ref, model) &&
                      "bg-interactive-active",
                  )}
                >
                  <span className="flex flex-1 flex-col">
                    <span>{info.label}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {modelDesc(t, info)}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
            </div>
          ) : null}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AutocompleteRow({
  keys,
  configuredIds,
  customProviders,
}: {
  keys: KeysMap;
  configuredIds: Set<ProviderId>;
  customProviders: readonly ProviderInstance[];
}) {
  const { t } = useTranslation();
  const enabled = usePreferencesStore((s) => s.autocompleteEnabled);
  const trigger = usePreferencesStore((s) => s.autocompleteTrigger);
  const model = usePreferencesStore((s) => s.autocompleteModel);
  const providerModels = usePreferencesStore((s) => s.providerModels);
  const eligible = useMemo(() => getAutocompleteEligibleModels(), []);
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);
  const aiCompleteShortcut = useMemo(() => {
    const s = SHORTCUTS.find((x) => x.id === "editor.aiComplete");
    const bindings = userShortcuts["editor.aiComplete"] || s?.defaultBindings;
    if (!bindings || bindings.length === 0) return "";
    return getBindingTokens(bindings[0]).join("");
  }, [userShortcuts]);

  // 快速云模型、已配置本地模型和自定义 Provider 共用结构化引用。
  const items = useMemo(() => {
    const local = PROVIDERS.filter(
      (p) =>
        isLocalProvider(p.id) &&
        p.id !== "openai-compatible" &&
        configuredIds.has(p.id),
    ).flatMap((p) => {
      const modelId = providerModels[builtinProviderId(p.id)]?.trim();
      if (!modelId) return [];
      const ref = modelRefForProvider(p.id, modelId);
      return [{ ref, info: resolveModel(ref) }];
    });
    const cloud = eligible.map((info) => ({
      ref: modelRefForProvider(info.provider, info.id),
      info,
    }));
    const custom = customProviders.flatMap((provider) => {
      const modelId = providerModels[provider.id]?.trim();
      if (!provider.baseURL.trim() || !modelId) return [];
      const ref = { providerId: provider.id, modelId };
      return [{ ref, info: resolveModel(ref, customProviders) }];
    });
    return [...cloud, ...local, ...custom];
  }, [configuredIds, customProviders, eligible, providerModels]);

  const currentModel = useMemo(
    () =>
      tryResolveModel(model, customProviders) ??
      resolveModel(DEFAULT_MODEL_REF),
    [customProviders, model],
  );

  const setModel = (ref: ModelRef) => {
    void setAutocompleteModel(ref);
  };

  const grouped = useMemo(() => {
    const map = new Map<ProviderId, (typeof items)[number][]>();
    for (const item of items) {
      const arr = map.get(item.info.provider) ?? [];
      arr.push(item);
      map.set(item.info.provider, arr);
    }
    return map;
  }, [items]);

  const hasKey = providerNeedsKey(currentModel.provider)
    ? !!keys[currentModel.provider]
    : true;

  return (
    <>
      <FieldRow label={t("models.defaults.autocomplete")}>
        <div className="flex flex-1 items-center gap-2">
          <Switch
            checked={enabled}
            onCheckedChange={(v) => void setAutocompleteEnabled(v)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                disabled={!enabled}
                className="h-8 flex-1 justify-between gap-2 px-2.5 text-[11.5px]"
              >
                <span className="flex items-center gap-2 truncate">
                  <ProviderIcon provider={currentModel.provider} size={12} />
                  <span className="truncate">{currentModel.label}</span>
                  <span className="text-muted-foreground">
                    · {modelHint(t, currentModel)}
                  </span>
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
              align="start"
              collisionPadding={12}
              className="max-h-72 min-w-70 overflow-y-auto"
            >
              {PROVIDERS.map((p) => {
                const list = grouped.get(p.id);
                if (!list || list.length === 0) return null;
                const pConfigured =
                  p.id === "openai-compatible" || configuredIds.has(p.id);
                return (
                  <div key={p.id} className="px-1 pt-1.5 first:pt-1">
                    <div className="mb-0.5 flex items-center gap-1.5 px-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                      <ProviderIcon provider={p.id} size={11} />
                      <span>{p.label}</span>
                      {!pConfigured ? (
                        <span className="ml-auto text-[9.5px] normal-case tracking-normal text-muted-foreground">
                          {t("models.providers.notConnected")}
                        </span>
                      ) : null}
                    </div>
                    {list.map(({ ref, info }) => (
                      <DropdownMenuItem
                        key={modelRefKey(ref)}
                        disabled={!pConfigured}
                        onSelect={() => pConfigured && setModel(ref)}
                        className={cn(
                          "text-[11.5px]",
                          modelRefsEqual(ref, model) && "bg-interactive-active",
                        )}
                      >
                        <span className="flex flex-col">
                          <span>{info.label}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {modelDesc(t, info)}
                          </span>
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </div>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </FieldRow>
      {enabled ? (
        <FieldRow label={t("models.defaults.trigger.label")}>
          <Select
            value={trigger}
            onValueChange={(v) =>
              void setAutocompleteTrigger(v as AutocompleteTrigger)
            }
          >
            <SelectTrigger className="h-8 w-full text-[11.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">
                {t("models.defaults.trigger.automatic")}
              </SelectItem>
              <SelectItem value="manual">
                {t("models.defaults.trigger.manual", {
                  shortcut:
                    aiCompleteShortcut || t("models.defaults.trigger.shortcut"),
                })}
              </SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
      ) : null}
      {enabled && !hasKey ? (
        <p className="pl-19 text-[10.5px] text-muted-foreground">
          {t("models.defaults.notConnectedHint", {
            provider: getProvider(currentModel.provider).label,
          })}
        </p>
      ) : null}
    </>
  );
}

function LocalProviderCard({
  provider,
  configured,
  config,
  meta,
  providerKey,
  onSaveKey,
  onClearKey,
  onRemove,
}: {
  provider: ProviderInfo;
  configured: boolean;
  config: LocalConfig;
  meta: LocalMeta;
  providerKey?: string | null;
  onSaveKey: (v: string) => Promise<void>;
  onClearKey: () => Promise<void>;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const { baseURL, modelId, setBaseURL, setModelId, noBaseURL } = config;
  const [urlDraft, setUrlDraft] = useState(baseURL);
  const [modelDraft, setModelDraft] = useState(modelId);
  const [keyDraft, setKeyDraft] = useState("");
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "ok" | "fail"
  >("idle");

  useEffect(() => setUrlDraft(baseURL), [baseURL]);
  useEffect(() => setModelDraft(modelId), [modelId]);

  const supportsKey = provider.id === "openrouter";

  const test = async () => {
    setTestStatus("testing");
    try {
      const status = await invoke<number>("lm_ping", { baseUrl: urlDraft });
      setTestStatus(status > 0 ? "ok" : "fail");
    } catch {
      setTestStatus("fail");
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderIcon provider={provider.id} size={15} />
        <span className="text-[12.5px] font-medium">{provider.label}</span>
        {configured ? (
          <Badge
            variant="outline"
            className="ml-1 h-4 gap-1 border-border/60 bg-muted/40 px-1.5 text-[10px] font-normal text-muted-foreground"
          >
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              size={9}
              strokeWidth={2}
            />
            {t("common.connected")}
          </Badge>
        ) : null}
        <button
          type="button"
          onClick={() => void openUrl(provider.consoleUrl)}
          className="ml-auto inline-flex items-center gap-0.5 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("models.card.docs")}
          <HugeiconsIcon
            icon={ArrowUpRight01Icon}
            size={11}
            strokeWidth={1.75}
          />
        </button>
        <Button
          size="icon"
          variant="ghost"
          onClick={onRemove}
          title={t("models.card.removeProvider")}
          className="size-7 text-muted-foreground hover:text-destructive"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
        </Button>
      </div>

      <span className="text-[10.5px] leading-relaxed text-muted-foreground">
        {meta.description}
      </span>

      <div className="mt-0.5 flex flex-col gap-2.5">
        {noBaseURL ? null : (
          <FieldRow label={t("models.card.baseUrl")}>
            <div className="flex flex-1 gap-1.5">
              <Input
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onBlur={() => {
                  const v = urlDraft.trim();
                  if (v !== baseURL) void setBaseURL(v);
                }}
                placeholder={meta.urlPlaceholder}
                spellCheck={false}
                className="h-8 flex-1 font-mono text-[11.5px]"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => void test()}
                disabled={!urlDraft.trim()}
                className="h-8 px-3 text-[11px]"
              >
                {t("models.card.test")}
              </Button>
            </div>
          </FieldRow>
        )}

        <FieldRow label={t("models.card.modelId")}>
          <Input
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            onBlur={() => {
              const v = modelDraft.trim();
              if (v !== modelId) void setModelId(v);
            }}
            placeholder={meta.modelPlaceholder}
            spellCheck={false}
            className="h-8 font-mono text-[11.5px]"
          />
        </FieldRow>

        {supportsKey ? (
          <FieldRow label={t("models.card.apiKey")}>
            {providerKey ? (
              <div className="flex flex-1 items-center gap-1.5">
                <code className="flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {`${providerKey.slice(0, 4)}${"•".repeat(8)}${providerKey.slice(-4)}`}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => void onClearKey()}
                  title={t("models.card.removeKey")}
                  className="size-7 text-muted-foreground hover:text-destructive"
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
              </div>
            ) : (
              <div className="flex flex-1 gap-1.5">
                <Input
                  type="password"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder={t("models.card.optionalKeyPlaceholder")}
                  spellCheck={false}
                  className="h-8 flex-1 font-mono text-[11.5px]"
                />
                <Button
                  size="sm"
                  onClick={async () => {
                    const v = keyDraft.trim();
                    if (!v) return;
                    await onSaveKey(v);
                    setKeyDraft("");
                  }}
                  disabled={!keyDraft.trim()}
                  className="h-8 px-3 text-[11px]"
                >
                  {t("common.save")}
                </Button>
              </div>
            )}
          </FieldRow>
        ) : null}

        <StatusLine status={testStatus} />

        {!modelId.trim() && meta.modelHint ? (
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            {meta.modelHint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function CustomProviderCard({
  provider,
  modelId,
  providerKey,
  onSaveKey,
  onClearKey,
  onUpdate,
  onUpdateModel,
  onRemove,
}: {
  provider: ProviderInstance;
  modelId: string;
  providerKey: string | null;
  onSaveKey: (v: string) => Promise<void>;
  onClearKey: () => Promise<void>;
  onUpdate: (patch: ProviderInstanceUpdate) => Promise<void>;
  onUpdateModel: (modelId: string) => Promise<void>;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(
    !provider.baseURL.trim() || !modelId.trim(),
  );
  const [nameDraft, setNameDraft] = useState(provider.name);
  const [urlDraft, setUrlDraft] = useState(provider.baseURL);
  const [modelDraft, setModelDraft] = useState(modelId);
  const [contextDraft, setContextDraft] = useState(
    String(provider.contextLimit),
  );
  const [keyDraft, setKeyDraft] = useState("");
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "ok" | "fail"
  >("idle");

  useEffect(() => setNameDraft(provider.name), [provider.name]);
  useEffect(() => setUrlDraft(provider.baseURL), [provider.baseURL]);
  useEffect(() => setModelDraft(modelId), [modelId]);
  useEffect(
    () => setContextDraft(String(provider.contextLimit)),
    [provider.contextLimit],
  );

  const configured = !!provider.baseURL.trim() && !!modelId.trim();

  const test = async () => {
    setTestStatus("testing");
    try {
      const status = await invoke<number>("lm_ping", { baseUrl: urlDraft });
      setTestStatus(status > 0 ? "ok" : "fail");
    } catch {
      setTestStatus("fail");
    }
  };

  return (
    <div className="flex flex-col rounded-lg border border-border/60 bg-card/60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 px-3 py-2 text-left"
      >
        <HugeiconsIcon
          icon={ChevronDown}
          size={12}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            !expanded && "-rotate-90",
          )}
        />
        <ProviderIcon provider="openai-compatible" size={15} />
        <span className="text-[12.5px] font-medium truncate">
          {provider.name || t("models.providers.openaiCompatible")}
        </span>
        {modelId.trim() && (
          <span className="text-[10.5px] text-muted-foreground truncate font-mono">
            {modelId}
          </span>
        )}
        {configured ? (
          <Badge
            variant="outline"
            className="ml-1 h-4 gap-1 border-border/60 bg-muted/40 px-1.5 text-[10px] font-normal text-muted-foreground"
          >
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              size={9}
              strokeWidth={2}
            />
            {t("common.connected")}
          </Badge>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title={t("models.card.removeEndpoint")}
          className="ml-auto size-7 text-muted-foreground hover:text-destructive"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
        </Button>
      </button>

      {expanded && (
        <div className="flex flex-col gap-2.5 border-t border-border/40 px-3 py-2.5">
          <FieldRow label={t("models.card.name")}>
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                const v = nameDraft.trim();
                if (v !== provider.name) void onUpdate({ name: v });
              }}
              placeholder={t("models.card.namePlaceholder")}
              spellCheck={false}
              className="h-8 flex-1 text-[11.5px]"
            />
          </FieldRow>

          <FieldRow label={t("models.card.baseUrl")}>
            <div className="flex flex-1 gap-1.5">
              <Input
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onBlur={() => {
                  const v = urlDraft.trim();
                  if (v !== provider.baseURL) void onUpdate({ baseURL: v });
                }}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
                className="h-8 flex-1 font-mono text-[11.5px]"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => void test()}
                disabled={!urlDraft.trim()}
                className="h-8 px-3 text-[11px]"
              >
                {t("models.card.test")}
              </Button>
            </div>
          </FieldRow>

          <FieldRow label={t("models.card.modelId")}>
            <Input
              value={modelDraft}
              onChange={(e) => setModelDraft(e.target.value)}
              onBlur={() => {
                const v = modelDraft.trim();
                if (v !== modelId) void onUpdateModel(v);
              }}
              placeholder="gpt-4o, qwen3-max, glm-4.6, …"
              spellCheck={false}
              className="h-8 font-mono text-[11.5px]"
            />
          </FieldRow>

          <FieldRow label={t("models.card.context")}>
            <div className="flex flex-1 items-center gap-1.5">
              <Input
                value={contextDraft}
                onChange={(e) => setContextDraft(e.target.value)}
                onBlur={() => {
                  const v = parseInt(contextDraft, 10);
                  if (Number.isFinite(v) && v >= 1000)
                    void onUpdate({ contextLimit: v });
                  else setContextDraft(String(provider.contextLimit));
                }}
                placeholder="128000"
                spellCheck={false}
                className="h-8 w-28 font-mono text-[11.5px]"
              />
              <span className="text-[10.5px] text-muted-foreground">
                {t("models.card.tokens")}
              </span>
            </div>
          </FieldRow>

          <FieldRow label={t("models.card.apiKey")}>
            {providerKey ? (
              <div className="flex flex-1 items-center gap-1.5">
                <code className="flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {`${providerKey.slice(0, 4)}${"•".repeat(8)}${providerKey.slice(-4)}`}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => void onClearKey()}
                  title={t("models.card.removeKey")}
                  className="size-7 text-muted-foreground hover:text-destructive"
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
              </div>
            ) : (
              <div className="flex flex-1 gap-1.5">
                <Input
                  type="password"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder={t("models.card.optionalKeyPlaceholder")}
                  spellCheck={false}
                  className="h-8 flex-1 font-mono text-[11.5px]"
                />
                <Button
                  size="sm"
                  onClick={async () => {
                    const v = keyDraft.trim();
                    if (!v) return;
                    await onSaveKey(v);
                    setKeyDraft("");
                  }}
                  disabled={!keyDraft.trim()}
                  className="h-8 px-3 text-[11px]"
                >
                  {t("common.save")}
                </Button>
              </div>
            )}
          </FieldRow>

          <StatusLine status={testStatus} />
        </div>
      )}
    </div>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-[11px] tracking-tight text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-1 items-center">{children}</div>
    </div>
  );
}

function StatusLine({
  status,
}: {
  status: "idle" | "testing" | "ok" | "fail";
}) {
  const { t } = useTranslation();
  if (status === "idle") return null;
  if (status === "testing") {
    return (
      <span className="text-[10.5px] text-muted-foreground">
        {t("models.card.testing")}
      </span>
    );
  }
  if (status === "ok") {
    return (
      <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
        <HugeiconsIcon icon={CheckmarkCircle02Icon} size={11} strokeWidth={2} />
        {t("models.card.reachable")}
      </span>
    );
  }
  return (
    <span className="text-[10.5px] text-destructive">
      {t("models.card.unreachable")}
    </span>
  );
}

function VoiceBlock() {
  const { t } = useTranslation();
  const sttProvider = usePreferencesStore((s) => s.sttProvider);
  const groqSttModel = usePreferencesStore((s) => s.groqSttModel);
  const whispercppBaseURL = usePreferencesStore((s) => s.whispercppBaseURL);
  const [urlDraft, setUrlDraft] = useState(whispercppBaseURL);
  const [groqModelDraft, setGroqModelDraft] = useState(groqSttModel);

  useEffect(() => setUrlDraft(whispercppBaseURL), [whispercppBaseURL]);
  useEffect(() => setGroqModelDraft(groqSttModel), [groqSttModel]);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <HugeiconsIcon icon={Mic01Icon} size={15} strokeWidth={1.5} />
        <span className="text-[12.5px] font-medium">
          {t("models.voice.title")}
        </span>
      </div>

      <FieldRow label={t("models.voice.provider")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="h-8 flex-1 justify-between gap-2 px-2.5 text-[11.5px]"
            >
              <span>{sttLabel(t, sttProvider)}</span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={11}
                strokeWidth={2}
                className="opacity-70"
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44 p-1">
            {(Object.keys(STT_PROVIDER_LABELS) as SttProvider[]).map((p) => (
              <DropdownMenuItem
                key={p}
                onSelect={() => void setSttProvider(p)}
                className={cn(
                  "flex items-center gap-2 text-[12px]",
                  p === sttProvider && "bg-interactive-active",
                )}
              >
                <span>{sttLabel(t, p)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </FieldRow>

      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        {sttProvider === "openai" && t("models.voice.descOpenai")}
        {sttProvider === "groq" && t("models.voice.descGroq")}
        {sttProvider === "whispercpp" && t("models.voice.descWhispercpp")}
      </p>

      {sttProvider === "groq" && (
        <div className="flex flex-col gap-2.5">
          <FieldRow label={t("models.voice.model")}>
            <Input
              value={groqModelDraft}
              onChange={(e) => setGroqModelDraft(e.target.value)}
              onBlur={() => {
                const v = groqModelDraft.trim();
                if (v !== groqSttModel) void setGroqSttModel(v);
              }}
              placeholder="whisper-large-v3-turbo"
              spellCheck={false}
              className="h-8 font-mono text-[11.5px]"
            />
          </FieldRow>
        </div>
      )}

      {sttProvider === "whispercpp" && (
        <div className="flex flex-col gap-2.5">
          <FieldRow label={t("models.voice.baseUrl")}>
            <Input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onBlur={() => {
                const v = urlDraft.trim();
                if (v !== whispercppBaseURL) void setWhispercppBaseURL(v);
              }}
              placeholder={WHISPERCPP_DEFAULT_BASE_URL}
              spellCheck={false}
              className="h-8 font-mono text-[11.5px]"
            />
          </FieldRow>
        </div>
      )}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * 本文件呈现主 Agent、Subagent、模型参数、提供商和语音输入设置。
 * 负责绑定偏好与密钥状态，并在模型或 Provider 配置变化时同步关联引用。
 */

import { Button } from "@/components/controls/button";
import { Input } from "@/components/controls/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/controls/select";
import { Hint } from "@/components/controls/tooltip";
import { PageHeader, SectionHeading } from "@/components/layout/PageHeader";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { deleteSharedStoreKey } from "@/lib/sharedStore";
import { cn } from "@/lib/utils";
import { ContentReveal } from "@/components/controls/content-reveal";
import { ModelPicker } from "@/modules/ai/components/ModelPicker";
import { ModelRequestSettings } from "@/modules/ai/components/ModelRequestSettings";
import { ProviderIcon } from "@/modules/ai/components/ProviderIcon";
import {
  builtinProviderId,
  type ConfiguredModel,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  type ModelRef,
  modelRefKey,
  modelRefsEqual,
  normalizeConfiguredModels,
  PROVIDERS,
  type ProviderBaseURLs,
  type ProviderId,
  type ProviderInfo,
  type ProviderInstance,
  type ProviderModels,
  parseModelContextWindow,
  resolveProviderBaseURL,
  resolveProviderInstance,
  STT_PROVIDER_LABELS,
  type SttProvider,
  tryResolveModel,
  WHISPERCPP_DEFAULT_BASE_URL,
} from "@/modules/ai/config";
import {
  clearKey,
  clearProviderInstanceKey,
  getAllKeys,
  getAllProviderInstanceKeys,
  type ProviderInstanceKeys,
  setKey,
  setProviderInstanceKey,
} from "@/modules/ai/lib/keyring";
import { getAvailableModelRefs } from "@/modules/ai/lib/modelAvailability";
import { modelCatalog } from "@/modules/ai/lib/modelCatalog";
import { buildModelReferencePatch } from "@/modules/ai/lib/modelPrefs";
import {
  createProviderConnection,
  isProviderConnectionReady,
  type ResolvedProviderConnection,
} from "@/modules/ai/providerRegistry";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { NetworkRouteSelect } from "@/modules/network/NetworkRouteSelect";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AGENT_STEPS_MAX,
  AGENT_STEPS_MIN,
  type AutocompleteTrigger,
  clampAgentSteps,
  MAX_AGENT_STEPS_DEFAULT,
  MAX_CONCURRENT_SUBAGENTS_MAX,
  MAX_CONCURRENT_SUBAGENTS_MIN,
  MAX_SUBAGENT_STEPS_DEFAULT,
  type ModelSettingsPatch,
  normalizeMainAgentSteps,
  setAutocompleteEnabled,
  setAutocompleteTrigger,
  setDefaultModel,
  setGroqSttModel,
  setMaxAgentSteps,
  setMaxConcurrentSubagents,
  setMaxSubagentSteps,
  setModelSettings,
  setProviderBaseURL,
  setModelUsageModel,
  setModelUsageParameters,
  setSttProvider,
  setWhispercppBaseURL,
} from "@/modules/settings/store";
import { getBindingTokens, SHORTCUTS } from "@/modules/shortcuts/shortcuts";
import { ModelParameterEditor } from "@/settings/components/ModelParameterEditor";
import { ProviderKeyCard } from "@/settings/components/ProviderKeyCard";
import { ProviderModelPicker } from "@/settings/components/ProviderModelPicker";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import ChevronDown from "@hugeicons/core-free-icons/ArrowDown01Icon";
import Mic01Icon from "@hugeicons/core-free-icons/Mic01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { reportError } from "@/lib/errors";
import { useTranslation } from "react-i18next";

type KeysMap = Record<ProviderId, string | null>;
type ProviderInstanceUpdate = Partial<
  Pick<ProviderInstance, "name" | "baseURL">
>;

type TFn = ReturnType<typeof useTranslation>["t"];
const sttLabel = (t: TFn, p: SttProvider): string =>
  t(`sttProvider.${p}`, {
    ns: "aiModels",
    keySeparator: false,
    nsSeparator: false,
    defaultValue: STT_PROVIDER_LABELS[p],
  });

const CONTEXT_WINDOW_PRESETS = [
  10_000, 32_000, 64_000, 128_000, 200_000, 250_000, 500_000, 1_000_000,
] as const;

function formatContextWindow(value: number): string {
  if (value % 1_000_000 === 0) return `${value / 1_000_000}m`;
  if (value % 1_000 === 0) return `${value / 1_000}k`;
  return String(value);
}

/** 模型设置主区域，组合 Agent 默认值、Subagent 并发及云端、本地和语音提供商配置。 */
export function ModelsSection() {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<KeysMap | null>(null);
  const [customProviderKeys, setCustomProviderKeys] =
    useState<ProviderInstanceKeys>({});
  const [adding, setAdding] = useState<Set<ProviderId>>(new Set());

  const defaultModel = usePreferencesStore((s) => s.defaultModel);
  const providerModels = usePreferencesStore((s) => s.providerModels);
  const providerBaseURLs = usePreferencesStore((s) => s.providerBaseURLs);
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
    modelCatalog.invalidate(builtinProviderId(provider));
  };

  const onClearKey = async (provider: ProviderId) => {
    await clearKey(provider);
    setKeys((prev) => (prev ? { ...prev, [provider]: null } : prev));
    modelCatalog.invalidate(builtinProviderId(provider));
  };

  const onSaveCustomProviderKey = async (providerId: string, value: string) => {
    await setProviderInstanceKey(providerId, value);
    setCustomProviderKeys((prev) => ({ ...prev, [providerId]: value }));
    modelCatalog.invalidate(providerId);
  };

  const onClearCustomProviderKey = async (providerId: string) => {
    await clearProviderInstanceKey(providerId);
    setCustomProviderKeys((prev) => ({ ...prev, [providerId]: null }));
    modelCatalog.invalidate(providerId);
  };

  const addCustomProvider = async () => {
    const provider: ProviderInstance = {
      id: `custom:${crypto.randomUUID()}`,
      protocol: "openai-compatible",
      name: "",
      baseURL: "",
    };
    await setModelSettings({
      customProviders: [...customProviders, provider],
    });
  };

  /** 计算持久化模型引用更新，不提前修改进程内聊天状态。 */
  const prepareReferenceUpdate = (
    matches: (model: ModelRef) => boolean,
    replacement: ModelRef | null,
  ): ModelSettingsPatch => {
    const prefs = usePreferencesStore.getState();
    return buildModelReferencePatch(prefs, matches, replacement);
  };

  /** 持久化成功后同步当前聊天选择，自动切换不计入最近使用。 */
  const syncChatReference = (
    matches: (model: ModelRef) => boolean,
    replacement: ModelRef | null,
  ) => {
    const chat = useChatStore.getState();
    if (chat.selectedModel && matches(chat.selectedModel)) {
      chat.setSelectedModel(replacement, false);
    }
  };

  const providerConnection = (
    providerId: string,
  ): ResolvedProviderConnection | null => {
    const connection = resolveProviderInstance(providerId, {
      customProviders,
      providerBaseURLs,
      providerCredentials: keys ?? undefined,
      providerInstanceCredentials: customProviderKeys,
    });
    return isProviderConnectionReady(connection) ? connection : null;
  };

  const firstAvailableModel = (
    models: ProviderModels,
    providers = customProviders,
  ): ModelRef | null => {
    if (!keys) return null;
    return (
      getAvailableModelRefs({
        apiKeys: keys,
        providerModels: models,
        providerBaseURLs,
        customProviders: providers,
      })[0] ?? null
    );
  };

  /** 保存一个 Provider 的用户模型集合，并级联清理被移除模型的引用。 */
  const updateProviderModels = async (
    providerId: string,
    models: ConfiguredModel[],
  ) => {
    const prefs = usePreferencesStore.getState();
    const normalized = normalizeConfiguredModels(models);
    const nextProviderModels = { ...prefs.providerModels };
    if (normalized.length > 0) nextProviderModels[providerId] = normalized;
    else delete nextProviderModels[providerId];
    const nextIds = new Set(normalized.map((model) => model.id));
    const removedIds = new Set(
      (prefs.providerModels[providerId] ?? [])
        .filter((model) => !nextIds.has(model.id))
        .map((model) => model.id),
    );
    const replacement = firstAvailableModel(nextProviderModels);
    const matchesRemoved = (model: ModelRef) =>
      model.providerId === providerId && removedIds.has(model.modelId);
    const referencePatch: ModelSettingsPatch =
      removedIds.size > 0
        ? prepareReferenceUpdate(matchesRemoved, replacement)
        : {};
    if (!prefs.defaultModel && replacement) {
      referencePatch.defaultModel = replacement;
    }
    await setModelSettings({
      ...referencePatch,
      providerModels: nextProviderModels,
    });
    if (removedIds.size > 0) syncChatReference(matchesRemoved, replacement);
    const chat = useChatStore.getState();
    if (!chat.selectedModel && replacement) {
      chat.setSelectedModel(replacement, false);
    }
  };

  /** 更新单个已保存模型的上下文窗口，不改变它的身份、来源或关联引用。 */
  const updateModelContextWindow = async (
    ref: ModelRef,
    contextWindow: number,
  ) => {
    const models =
      usePreferencesStore.getState().providerModels[ref.providerId];
    if (!models?.some((model) => model.id === ref.modelId)) return;
    await updateProviderModels(
      ref.providerId,
      models.map((model) =>
        model.id === ref.modelId ? { ...model, contextWindow } : model,
      ),
    );
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
    modelCatalog.invalidate(id);
    const matchesProvider = (model: ModelRef) => model.providerId === id;
    const replacement = firstAvailableModel(providerModels, nextProviders);
    const referencePatch = nextProvider.baseURL.trim()
      ? {}
      : prepareReferenceUpdate(matchesProvider, replacement);
    await setModelSettings({
      ...referencePatch,
      customProviders: nextProviders,
    });
    if (!nextProvider.baseURL.trim()) {
      syncChatReference(matchesProvider, replacement);
    }
  };

  const removeCustomProvider = async (id: string) => {
    const remaining = customProviders.filter((provider) => provider.id !== id);
    const nextProviderModels = { ...providerModels };
    delete nextProviderModels[id];
    const matchesProvider = (model: ModelRef) => model.providerId === id;
    const replacement = firstAvailableModel(nextProviderModels, remaining);
    const referencePatch = prepareReferenceUpdate(matchesProvider, replacement);
    await setModelSettings({
      ...referencePatch,
      customProviders: remaining,
      providerModels: nextProviderModels,
    });
    syncChatReference(matchesProvider, replacement);
    modelCatalog.invalidate(id);
    await deleteSharedStoreKey("settings", `network.provider:${id}`);
    await clearProviderInstanceKey(id);
    setCustomProviderKeys((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  };

  /** 地址覆盖只影响后续请求，恢复默认不会更换模型引用。 */
  const updateProviderBaseURL = async (provider: ProviderId, value: string) => {
    await setProviderBaseURL(provider, value);
    modelCatalog.invalidate(builtinProviderId(provider));
  };

  const isConfigured = (id: ProviderId): boolean => {
    const models = providerModels[builtinProviderId(id)] ?? [];
    if (models.length === 0) return false;
    const connection = providerConnection(builtinProviderId(id));
    return connection !== null;
  };

  const removeProvider = async (id: ProviderId) => {
    const providerId = builtinProviderId(id);
    const nextProviderModels = { ...providerModels };
    delete nextProviderModels[providerId];
    const matchesProvider = (model: ModelRef) =>
      model.providerId === providerId;
    const replacement = firstAvailableModel(nextProviderModels);
    const referencePatch = prepareReferenceUpdate(matchesProvider, replacement);
    const settingsPatch: ModelSettingsPatch = {
      ...referencePatch,
      providerModels: nextProviderModels,
    };
    await setProviderBaseURL(id, "");
    await setModelSettings(settingsPatch);
    syncChatReference(matchesProvider, replacement);
    modelCatalog.invalidate(providerId);
    await deleteSharedStoreKey("settings", `network.provider:${providerId}`);
    if (keys?.[id]) await onClearKey(id);
    setAdding((previous) => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  };

  if (!keys) {
    return (
      <div className="text-[12px] text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  const configuredIds = new Set(
    PROVIDERS.filter((provider) => isConfigured(provider.id)).map(
      (provider) => provider.id,
    ),
  );
  const visibleIds = new Set<ProviderId>(adding);
  for (const provider of PROVIDERS) {
    if (
      keys[provider.id] ||
      providerBaseURLs[provider.id] !== undefined ||
      (providerModels[builtinProviderId(provider.id)]?.length ?? 0) > 0
    ) {
      visibleIds.add(provider.id);
    }
  }
  const visibleProviders = PROVIDERS.filter((provider) =>
    visibleIds.has(provider.id),
  );
  const addableProviders = PROVIDERS.filter(
    (provider) => !visibleIds.has(provider.id),
  );
  const availableModels = getAvailableModelRefs({
    apiKeys: keys,
    providerModels,
    providerBaseURLs,
    customProviders,
  });
  const savedModels = Object.entries(providerModels).flatMap(
    ([providerId, models]) =>
      models.map((model) => ({ providerId, modelId: model.id })),
  );

  const addProvider = (id: ProviderId) => {
    setAdding((prev) => new Set(prev).add(id));
  };

  return (
    <div
      data-reveal-boundary
      className="@container flex min-w-0 flex-col gap-section"
    >
      <PageHeader
        title={t("models.header.title")}
        description={t("models.header.description")}
      />

      <DefaultsBlock
        defaultModel={defaultModel}
        models={availableModels}
        providerBaseURLs={providerBaseURLs}
        customProviders={customProviders}
      />

      <SubagentCard
        models={availableModels}
        providerBaseURLs={providerBaseURLs}
        customProviders={customProviders}
      />

      <AutocompleteCard
        models={availableModels}
        providerBaseURLs={providerBaseURLs}
        customProviders={customProviders}
      />

      <CompactionCard
        models={availableModels}
        providerBaseURLs={providerBaseURLs}
        customProviders={customProviders}
      />
      <CommitMessageCard
        models={availableModels}
        providerBaseURLs={providerBaseURLs}
        customProviders={customProviders}
      />

      <ModelParametersCard
        models={savedModels}
        providerModels={providerModels}
        providerBaseURLs={providerBaseURLs}
        customProviders={customProviders}
        preferredModel={defaultModel}
        onContextWindowChange={updateModelContextWindow}
      />

      <VoiceBlock />

      <div className="flex flex-col gap-field">
        <div className="flex items-center justify-between">
          <SectionHeading>{t("models.providers.label")}</SectionHeading>
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
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {t("models.providers.emptyHint")}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleProviders.map((provider) => {
              const providerId = builtinProviderId(provider.id);
              return (
                <ProviderKeyCard
                  key={provider.id}
                  provider={provider}
                  currentKey={keys[provider.id]}
                  configured={configuredIds.has(provider.id)}
                  onSave={(value) => onSaveKey(provider.id, value)}
                  onRemove={() => void removeProvider(provider.id)}
                >
                  <BuiltinProviderFields
                    provider={provider}
                    credentialValue={keys[provider.id]}
                    baseURL={resolveProviderBaseURL(
                      provider.id,
                      providerBaseURLs[provider.id],
                    )}
                    models={providerModels[providerId] ?? []}
                    onBaseURLChange={(value) =>
                      updateProviderBaseURL(provider.id, value)
                    }
                    onModelsChange={(models) =>
                      updateProviderModels(providerId, models)
                    }
                  />
                </ProviderKeyCard>
              );
            })}
            {customProviders.map((provider) => (
              <CustomProviderCard
                key={provider.id}
                provider={provider}
                models={providerModels[provider.id] ?? []}
                providerKey={customProviderKeys[provider.id] ?? null}
                onSaveKey={(value) =>
                  onSaveCustomProviderKey(provider.id, value)
                }
                onClearKey={() => onClearCustomProviderKey(provider.id)}
                onUpdate={(patch) => updateCustomProvider(provider.id, patch)}
                onUpdateModels={(models) =>
                  updateProviderModels(provider.id, models)
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
  const cloud = providers.filter((provider) => provider.category === "cloud");
  const local = providers.filter((provider) => provider.category === "local");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="px-2.5">
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
  models,
  providerBaseURLs,
  customProviders,
}: {
  defaultModel: ModelRef | null;
  models: readonly ModelRef[];
  providerBaseURLs: Readonly<ProviderBaseURLs>;
  customProviders: readonly ProviderInstance[];
}) {
  const { t } = useTranslation();
  const maxAgentSteps = usePreferencesStore((s) => s.maxAgentSteps);
  return (
    <div className="flex flex-col gap-field">
      <SectionHeading>{t("models.defaults.label")}</SectionHeading>
      <div className="flex flex-col gap-field rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
        <FieldRow label={t("models.defaults.chatModel")}>
          <ModelPicker
            model={defaultModel}
            models={models}
            providerBaseURLs={providerBaseURLs}
            customProviders={customProviders}
            onSelect={(model) => void setDefaultModel(model)}
          />
        </FieldRow>
        <FieldRow label={t("models.defaults.agentSteps")}>
          <AgentStepLimitInput
            value={maxAgentSteps}
            fallback={MAX_AGENT_STEPS_DEFAULT}
            allowUnlimited
            help={t("models.defaults.agentStepsRange")}
            onChange={setMaxAgentSteps}
          />
        </FieldRow>
      </div>
    </div>
  );
}

/** 运行模型选择与参数编辑独立；编辑其他模型的参数不改变 Subagent 的运行选择。 */
function SubagentCard({
  models,
  providerBaseURLs,
  customProviders,
}: {
  models: readonly ModelRef[];
  providerBaseURLs: Readonly<ProviderBaseURLs>;
  customProviders: readonly ProviderInstance[];
}) {
  const { t } = useTranslation();
  const usage = usePreferencesStore((s) => s.modelUsages.subagent);
  const definitions = usePreferencesStore((s) => s.modelParameters);
  const defaultModel = usePreferencesStore((s) => s.defaultModel);
  const maxConcurrentSubagents = usePreferencesStore(
    (s) => s.maxConcurrentSubagents,
  );
  const maxSubagentSteps = usePreferencesStore((s) => s.maxSubagentSteps);
  const [previewModel, setPreviewModel] = useState<ModelRef | null>(
    () => usage.model ?? defaultModel ?? models[0] ?? null,
  );
  const parameterModel =
    models.find(
      (model) => previewModel && modelRefsEqual(model, previewModel),
    ) ??
    models[0] ??
    null;
  return (
    <div className="flex flex-col gap-field">
      <SectionHeading>{t("models.subagent.title")}</SectionHeading>
      <div className="flex flex-col gap-field rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
        <FieldRow label={t("models.defaults.subagentConcurrency")}>
          <Select
            value={String(maxConcurrentSubagents)}
            onValueChange={(value) =>
              void setMaxConcurrentSubagents(Number(value))
            }
          >
            <SelectTrigger className="w-full">
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

        <FieldRow label={t("models.defaults.subagentSteps")}>
          <AgentStepLimitInput
            value={maxSubagentSteps}
            fallback={MAX_SUBAGENT_STEPS_DEFAULT}
            help={t("models.defaults.subagentStepsRange")}
            onChange={(value) =>
              setMaxSubagentSteps(value ?? MAX_SUBAGENT_STEPS_DEFAULT)
            }
          />
        </FieldRow>

        <FieldRow label={t("models.defaults.subagentModel")}>
          <ModelPicker
            model={usage.model}
            models={models}
            providerBaseURLs={providerBaseURLs}
            customProviders={customProviders}
            inheritLabel={t("models.defaults.followChatModel")}
            ariaLabel={t("models.defaults.subagentModel")}
            onSelect={(model) => {
              void setModelUsageModel("subagent", model).catch((e) =>
                reportError(t("common:errors.saveFailed"), { error: e }),
              );
            }}
          />
        </FieldRow>
        {usage.model &&
          !models.some(
            (model) => usage.model && modelRefsEqual(model, usage.model),
          ) && (
            <p role="alert" className="text-xs text-destructive">
              {t("models.subagent.unavailable")}
            </p>
          )}
        <div className="border-t border-border/60 pt-3">
          <ModelRequestSettings
            model={parameterModel}
            models={models}
            providerBaseURLs={providerBaseURLs}
            customProviders={customProviders}
            parameters={
              parameterModel
                ? (definitions[modelRefKey(parameterModel)] ?? [])
                : []
            }
            selections={
              parameterModel
                ? (usage.parameterSelections[modelRefKey(parameterModel)] ?? {})
                : {}
            }
            onSelect={setPreviewModel}
            onParametersChange={(selections) => {
              if (!parameterModel) return;
              void setModelUsageParameters(
                "subagent",
                parameterModel,
                selections,
              ).catch((e) =>
                reportError(t("common:errors.saveFailed"), { error: e }),
              );
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t("models.subagent.followHelp")}
        </p>
      </div>
    </div>
  );
}

/** 压缩默认跟随本轮模型和参数，运行选择与参数编辑分别保存。 */
function CompactionCard({
  models,
  providerBaseURLs,
  customProviders,
}: {
  models: readonly ModelRef[];
  providerBaseURLs: Readonly<ProviderBaseURLs>;
  customProviders: readonly ProviderInstance[];
}) {
  const { t } = useTranslation();
  const usage = usePreferencesStore((state) => state.modelUsages.compaction);
  const definitions = usePreferencesStore((state) => state.modelParameters);
  const [preview, setPreview] = useState<ModelRef | null>(null);
  const model = preview ?? usage.model ?? models[0] ?? null;
  return (
    <div className="flex flex-col gap-field">
      <SectionHeading>{t("models.compaction.title")}</SectionHeading>
      <div className="flex flex-col gap-field rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
        <FieldRow label={t("models.parameters.model")}>
          <ModelPicker
            model={usage.model}
            models={models}
            providerBaseURLs={providerBaseURLs}
            customProviders={customProviders}
            inheritLabel={t("models.defaults.followChatModel")}
            onSelect={(value) => {
              void setModelUsageModel("compaction", value).catch((e) =>
                reportError(t("common:errors.saveFailed"), { error: e }),
              );
            }}
          />
        </FieldRow>
        <ModelRequestSettings
          model={model}
          models={models}
          providerBaseURLs={providerBaseURLs}
          customProviders={customProviders}
          parameters={model ? (definitions[modelRefKey(model)] ?? []) : []}
          selections={
            model ? (usage.parameterSelections[modelRefKey(model)] ?? {}) : {}
          }
          onSelect={setPreview}
          onParametersChange={(selections) => {
            if (model) {
              void setModelUsageParameters(
                "compaction",
                model,
                selections,
              ).catch((e) =>
                reportError(t("common:errors.saveFailed"), { error: e }),
              );
            }
          }}
        />
        <p className="text-xs text-muted-foreground">
          {t("models.compaction.followHelp")}
        </p>
      </div>
    </div>
  );
}

/** 延迟到失焦时保存，避免输入中的临时空值进入共享设置。 */
function AgentStepLimitInput({
  value,
  fallback,
  allowUnlimited = false,
  help,
  onChange,
}: {
  value: number | null;
  fallback: number | null;
  allowUnlimited?: boolean;
  help: string;
  onChange: (value: number | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(value ?? 0));
  useEffect(() => setDraft(String(value ?? 0)), [value]);

  const commit = () => {
    const raw = draft.trim() === "" ? fallback : Number(draft);
    const next = allowUnlimited
      ? normalizeMainAgentSteps(raw)
      : clampAgentSteps(raw ?? MAX_SUBAGENT_STEPS_DEFAULT, fallback ?? 32);
    setDraft(String(next ?? 0));
    if (next !== value) void onChange(next);
  };

  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      <Input
        type="number"
        min={allowUnlimited ? 0 : AGENT_STEPS_MIN}
        max={AGENT_STEPS_MAX}
        step={1}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="min-w-0 flex-1 border border-border bg-background px-2.5 text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span className="w-44 shrink-0 whitespace-nowrap text-[11px] leading-4 text-muted-foreground">
        {help}
      </span>
    </div>
  );
}

/** 提交信息使用独立模型配置，未指定时跟随全局默认模型。 */
function CommitMessageCard({
  models,
  providerBaseURLs,
  customProviders,
}: {
  models: readonly ModelRef[];
  providerBaseURLs: Readonly<ProviderBaseURLs>;
  customProviders: readonly ProviderInstance[];
}) {
  const { t } = useTranslation();
  const usage = usePreferencesStore((s) => s.modelUsages.commitMessage);
  const definitions = usePreferencesStore((s) => s.modelParameters);
  const defaultModel = usePreferencesStore((s) => s.defaultModel);
  const model = usage.model ?? defaultModel;
  return (
    <div className="flex flex-col gap-field">
      <SectionHeading>{t("models.commitMessage.title")}</SectionHeading>
      <div className="flex flex-col gap-field rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
        <ModelRequestSettings
          model={usage.model}
          inheritedModel={defaultModel}
          models={models}
          providerBaseURLs={providerBaseURLs}
          customProviders={customProviders}
          inheritLabel={t("models.commitMessage.defaultModel", {
            model: defaultModel?.modelId ?? t("models.commitMessage.none"),
          })}
          parameters={model ? (definitions[modelRefKey(model)] ?? []) : []}
          selections={
            model ? (usage.parameterSelections[modelRefKey(model)] ?? {}) : {}
          }
          onSelect={(selected) => {
            void setModelUsageModel("commitMessage", selected).catch((e) =>
              reportError(t("common:errors.saveFailed"), { error: e }),
            );
          }}
          onParametersChange={(selections) => {
            if (!model) return;
            void setModelUsageParameters(
              "commitMessage",
              model,
              selections,
            ).catch((e) =>
              reportError(t("common:errors.saveFailed"), { error: e }),
            );
          }}
        />
      </div>
    </div>
  );
}

/** 编辑已保存模型的上下文窗口及请求参数定义。 */
function ModelParametersCard({
  models,
  providerModels,
  providerBaseURLs,
  customProviders,
  preferredModel,
  onContextWindowChange,
}: {
  models: readonly ModelRef[];
  providerModels: Readonly<ProviderModels>;
  providerBaseURLs: Readonly<ProviderBaseURLs>;
  customProviders: readonly ProviderInstance[];
  preferredModel: ModelRef | null;
  onContextWindowChange: (
    model: ModelRef,
    contextWindow: number,
  ) => Promise<void>;
}) {
  const { t } = useTranslation();
  const initialModel =
    preferredModel &&
    models.some((model) => modelRefsEqual(model, preferredModel))
      ? preferredModel
      : (models[0] ?? null);
  const [selectedModel, setSelectedModel] = useState<ModelRef | null>(
    initialModel,
  );
  const configuredModel = selectedModel
    ? providerModels[selectedModel.providerId]?.find(
        (model) => model.id === selectedModel.modelId,
      )
    : undefined;
  const contextWindow =
    configuredModel?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW;
  const [contextDraft, setContextDraft] = useState(
    formatContextWindow(contextWindow),
  );

  useEffect(() => {
    if (
      selectedModel &&
      models.some((model) => modelRefsEqual(model, selectedModel))
    ) {
      return;
    }
    setSelectedModel(models[0] ?? null);
  }, [models, selectedModel]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 切换相同窗口值的模型时也必须重置未保存草稿。
  useEffect(() => {
    setContextDraft(formatContextWindow(contextWindow));
  }, [contextWindow, selectedModel]);

  const saveContextWindow = (value: string) => {
    if (!selectedModel) return;
    const parsed = parseModelContextWindow(value);
    if (parsed === null) {
      setContextDraft(formatContextWindow(contextWindow));
      return;
    }
    setContextDraft(formatContextWindow(parsed));
    if (parsed !== contextWindow) {
      void onContextWindowChange(selectedModel, parsed);
    }
  };

  return (
    <div className="flex flex-col gap-field">
      <SectionHeading>{t("models.parameters.label")}</SectionHeading>
      <div className="flex flex-col gap-field rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
        <FieldRow label={t("models.parameters.model")}>
          <ModelPicker
            model={selectedModel}
            models={models}
            providerBaseURLs={providerBaseURLs}
            customProviders={customProviders}
            onSelect={setSelectedModel}
          />
        </FieldRow>
        <FieldRow label={t("models.parameters.contextWindow")}>
          <div className="flex flex-1 items-center gap-1.5">
            <Input
              value={contextDraft}
              onChange={(event) => setContextDraft(event.target.value)}
              onBlur={() => saveContextWindow(contextDraft)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.currentTarget.blur();
              }}
              disabled={!selectedModel}
              placeholder={formatContextWindow(DEFAULT_MODEL_CONTEXT_WINDOW)}
              inputMode="decimal"
              spellCheck={false}
              className="flex-1 font-mono"
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Hint content={t("models.parameters.selectPreset")}>
                  <Button
                    aria-label={t("models.parameters.selectPreset")}
                    type="button"
                    size="icon"
                    variant="outline"
                    disabled={!selectedModel}
                    className="shrink-0"
                  >
                    <HugeiconsIcon
                      icon={ArrowDown01Icon}
                      size={11}
                      strokeWidth={2}
                    />
                  </Button>
                </Hint>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-28 p-1">
                {CONTEXT_WINDOW_PRESETS.map((preset) => (
                  <DropdownMenuItem
                    key={preset}
                    onSelect={() => saveContextWindow(String(preset))}
                    className={cn(
                      "font-mono text-xs",
                      preset === contextWindow && "bg-interactive-active",
                    )}
                  >
                    {formatContextWindow(preset)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="text-[11px] text-muted-foreground">
              {t("models.parameters.tokens")}
            </span>
          </div>
        </FieldRow>
        <p className="@min-[30rem]:pl-31 text-[11px] leading-4 text-muted-foreground">
          {t("models.parameters.description")}
        </p>
        <ContentReveal
          open={!!selectedModel}
          transitionKey={selectedModel ? modelRefKey(selectedModel) : null}
        >
          {selectedModel && (
            <div className="border-t border-border/60 pt-3">
              <ModelParameterEditor
                key={modelRefKey(selectedModel)}
                model={selectedModel}
              />
            </div>
          )}
        </ContentReveal>
      </div>
    </div>
  );
}

/** 独立配置编辑器补全，行为设置在前，模型与请求参数在后。 */
function AutocompleteCard({
  models,
  providerBaseURLs,
  customProviders,
}: {
  models: readonly ModelRef[];
  providerBaseURLs: Readonly<ProviderBaseURLs>;
  customProviders: readonly ProviderInstance[];
}) {
  const { t } = useTranslation();
  const enabled = usePreferencesStore((state) => state.autocompleteEnabled);
  const trigger = usePreferencesStore((state) => state.autocompleteTrigger);
  const usage = usePreferencesStore((state) => state.modelUsages.completion);
  const model = usage.model;
  const parameterDefinitions = usePreferencesStore(
    (state) => state.modelParameters,
  );
  const completionSelections = usage.parameterSelections;
  const userShortcuts = usePreferencesStore((state) => state.shortcuts);
  const currentModel = tryResolveModel(model, {
    customProviders,
    providerBaseURLs,
  });
  const aiCompleteShortcut = useMemo(() => {
    const shortcut = SHORTCUTS.find((item) => item.id === "editor.aiComplete");
    const bindings =
      userShortcuts["editor.aiComplete"] || shortcut?.defaultBindings;
    if (!bindings || bindings.length === 0) return "";
    return getBindingTokens(bindings[0]).join("");
  }, [userShortcuts]);
  const toggleEnabled = async (next: boolean) => {
    if (next && !model) {
      const first = models[0];
      if (!first) return;
      await setModelUsageModel("completion", first);
    }
    await setAutocompleteEnabled(next);
  };

  return (
    <div className="flex flex-col gap-field">
      <SectionHeading>{t("models.defaults.autocomplete")}</SectionHeading>
      <div className="flex flex-col gap-field rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
        <FieldRow label={t("models.defaults.autocomplete")}>
          <div className="flex flex-1 justify-end">
            <Switch
              aria-label={t("models.defaults.autocomplete")}
              checked={enabled && currentModel !== null}
              disabled={models.length === 0}
              onCheckedChange={(value) => void toggleEnabled(value)}
            />
          </div>
        </FieldRow>
        <FieldRow label={t("models.defaults.trigger.label")}>
          <Select
            disabled={!enabled || !currentModel}
            value={trigger}
            onValueChange={(value) =>
              void setAutocompleteTrigger(value as AutocompleteTrigger)
            }
          >
            <SelectTrigger
              className="w-full"
              aria-label={t("models.defaults.trigger.label")}
            >
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
        <div className="border-t border-border/60 pt-3">
          <ModelRequestSettings
            model={model}
            models={models}
            providerBaseURLs={providerBaseURLs}
            customProviders={customProviders}
            disabled={!enabled}
            parameters={
              model ? (parameterDefinitions[modelRefKey(model)] ?? []) : []
            }
            selections={
              model ? (completionSelections[modelRefKey(model)] ?? {}) : {}
            }
            onSelect={(next) => {
              void setModelUsageModel("completion", next).catch((error) =>
                reportError(t("common:errors.saveFailed"), { error }),
              );
            }}
            onParametersChange={(next) => {
              if (!model) return;
              void setModelUsageParameters("completion", model, next).catch(
                (error) =>
                  reportError(t("common:errors.saveFailed"), { error }),
              );
            }}
          />
        </div>
      </div>
    </div>
  );
}
/** 展示内置连接的地址、统一出口和模型目录。 */
function BuiltinProviderFields({
  provider,
  credentialValue,
  baseURL,
  models,
  onBaseURLChange,
  onModelsChange,
}: {
  provider: ProviderInfo;
  credentialValue: string | null;
  baseURL: string;
  models: readonly ConfiguredModel[];
  onBaseURLChange: (value: string) => Promise<void>;
  onModelsChange: (models: ConfiguredModel[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [baseURLDraft, setBaseURLDraft] = useState(baseURL);
  const [saving, setSaving] = useState(false);

  const saveBaseURL = async (value: string) => {
    const next = resolveProviderBaseURL(provider.id, value);
    setBaseURLDraft(next);
    if (next === baseURL) return;
    setSaving(true);
    try {
      await onBaseURLChange(value);
    } catch (error) {
      setBaseURLDraft(baseURL);
      reportError(t("common:errors.saveFailed"), { error });
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => setBaseURLDraft(baseURL), [baseURL]);

  const resolvedConnection = createProviderConnection({
    instanceId: builtinProviderId(provider.id),
    provider: provider.id,
    baseURL,
    credentialValue,
  });
  const connection = isProviderConnectionReady(resolvedConnection)
    ? resolvedConnection
    : null;

  return (
    <>
      {provider.category === "local" ? (
        <span className="text-[11px] leading-4 text-muted-foreground">
          {t(`models.local.${provider.id}.description`)}
        </span>
      ) : null}
      <FieldRow label={t("models.card.baseUrl")}>
        <Input
          value={baseURLDraft}
          disabled={saving}
          onChange={(event) => setBaseURLDraft(event.target.value)}
          onBlur={() => void saveBaseURL(baseURLDraft)}
          placeholder={provider.endpoint.defaultBaseURL}
          spellCheck={false}
          className="flex-1 font-mono"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={
            saving ||
            (baseURL === provider.endpoint.defaultBaseURL &&
              baseURLDraft === baseURL)
          }
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void saveBaseURL("")}
        >
          {t("models.card.resetBaseUrl")}
        </Button>
      </FieldRow>
      <NetworkRouteSelect
        target={`provider:${builtinProviderId(provider.id)}`}
      />
      <FieldRow label={t("models.catalog.models")}>
        <ProviderModelPicker
          connection={connection}
          models={models}
          onChange={onModelsChange}
        />
      </FieldRow>
    </>
  );
}

/** 编辑自定义连接，所有请求以该实例身份选择出口。 */
function CustomProviderCard({
  provider,
  models,
  providerKey,
  onSaveKey,
  onClearKey,
  onUpdate,
  onUpdateModels,
  onRemove,
}: {
  provider: ProviderInstance;
  models: readonly ConfiguredModel[];
  providerKey: string | null;
  onSaveKey: (v: string) => Promise<void>;
  onClearKey: () => Promise<void>;
  onUpdate: (patch: ProviderInstanceUpdate) => Promise<void>;
  onUpdateModels: (models: ConfiguredModel[]) => Promise<void>;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(
    !provider.baseURL.trim() || models.length === 0,
  );
  const [nameDraft, setNameDraft] = useState(provider.name);
  const [urlDraft, setUrlDraft] = useState(provider.baseURL);
  const [keyDraft, setKeyDraft] = useState("");

  useEffect(() => setNameDraft(provider.name), [provider.name]);
  useEffect(() => setUrlDraft(provider.baseURL), [provider.baseURL]);

  const configured = !!provider.baseURL.trim() && models.length > 0;
  const resolvedConnection = createProviderConnection({
    instanceId: provider.id,
    provider: provider.protocol,
    baseURL: urlDraft,
    credentialValue: providerKey,
  });

  return (
    <div className="flex flex-col rounded-lg border border-border/60 bg-card/60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex items-center gap-2 px-3 py-2 text-left"
      >
        <HugeiconsIcon
          icon={ChevronDown}
          size={12}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform duration-control ease-emphasized",
            !expanded && "-rotate-90",
          )}
        />
        <ProviderIcon provider="openai-compatible" size={15} />
        <span className="text-[12.5px] font-medium truncate">
          {provider.name || t("models.providers.openaiCompatible")}
        </span>
        {models.length > 0 && (
          <span className="text-[11px] text-muted-foreground truncate font-mono">
            {t("models.catalog.configuredCount", { count: models.length })}
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
            {t("common.configured")}
          </Badge>
        ) : null}
        <Hint content={t("models.card.removeEndpoint")}>
          <Button
            aria-label={t("models.card.removeEndpoint")}
            size="icon-sm"
            variant="ghost-destructive-hover"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="ml-auto"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
          </Button>
        </Hint>
      </button>

      <ContentReveal open={expanded} transitionKey={provider.id}>
        <div className="flex flex-col gap-field border-t border-border/40 px-3 py-2.5">
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
              className="flex-1"
            />
          </FieldRow>

          <FieldRow label={t("models.card.baseUrl")}>
            <Input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onBlur={() => {
                const v = urlDraft.trim();
                if (v !== provider.baseURL) void onUpdate({ baseURL: v });
              }}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
              className="flex-1 font-mono"
            />
          </FieldRow>

          <NetworkRouteSelect target={`provider:${provider.id}`} />
          <FieldRow label={t("models.catalog.models")}>
            <ProviderModelPicker
              connection={
                isProviderConnectionReady(resolvedConnection)
                  ? resolvedConnection
                  : null
              }
              models={models}
              onChange={onUpdateModels}
            />
          </FieldRow>

          <FieldRow label={t("models.card.apiKey")}>
            {providerKey ? (
              <div className="flex flex-1 items-center gap-1.5">
                <code className="flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {providerKey.length <= 8
                    ? "•".repeat(providerKey.length)
                    : `${providerKey.slice(0, 4)}${"•".repeat(8)}${providerKey.slice(-4)}`}
                </code>
                <Hint content={t("models.card.removeKey")}>
                  <Button
                    aria-label={t("models.card.removeKey")}
                    size="icon-sm"
                    variant="ghost-destructive-hover"
                    onClick={() => void onClearKey()}
                  >
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      size={12}
                      strokeWidth={1.75}
                    />
                  </Button>
                </Hint>
              </div>
            ) : (
              <div className="flex flex-1 gap-1.5">
                <Input
                  type="password"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder={t("models.card.optionalKeyPlaceholder")}
                  spellCheck={false}
                  className="flex-1 font-mono"
                />
                <Button
                  onClick={async () => {
                    const v = keyDraft.trim();
                    if (!v) return;
                    await onSaveKey(v);
                    setKeyDraft("");
                  }}
                  disabled={!keyDraft.trim()}
                >
                  {t("common.save")}
                </Button>
              </div>
            )}
          </FieldRow>
        </div>
      </ContentReveal>
    </div>
  );
}

/** 模型配置使用固定标签列；窄容器中转为纵向字段，避免挤压模型选择器。 */
function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-1 @min-[30rem]:grid-cols-[7rem_minmax(0,1fr)] @min-[30rem]:items-center @min-[30rem]:gap-3">
      <span className="text-xs leading-[18px] font-medium">{label}</span>
      <div className="flex min-w-0 items-center [&>*]:min-w-0">{children}</div>
    </div>
  );
}

/** 语音服务独立选择出口，本机离线服务固定直连。 */
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
    <div className="flex flex-col gap-field rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <HugeiconsIcon icon={Mic01Icon} size={15} strokeWidth={1.5} />
        <span className="text-[12.5px] font-medium">
          {t("models.voice.title")}
        </span>
      </div>

      <FieldRow label={t("models.voice.provider")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="flex-1 justify-between px-2.5">
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

      <p className="text-[11px] leading-4 text-muted-foreground">
        {sttProvider === "openai" && t("models.voice.descOpenai")}
        {sttProvider === "groq" && t("models.voice.descGroq")}
        {sttProvider === "whispercpp" && t("models.voice.descWhispercpp")}
      </p>

      {sttProvider !== "whispercpp" && (
        <NetworkRouteSelect target={`speech:${sttProvider}`} />
      )}
      {sttProvider === "groq" && (
        <div className="flex flex-col gap-field">
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
              className="font-mono"
            />
          </FieldRow>
        </div>
      )}

      {sttProvider === "whispercpp" && (
        <div className="flex flex-col gap-field">
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
              className="font-mono"
            />
          </FieldRow>
        </div>
      )}
    </div>
  );
}

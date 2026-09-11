/**
 * 配置单个 Channel 连接的模型使用方式，复用 AI 模型与参数组件。
 * 精确写入即时生效于后续任务，不修改连接草稿或重建接收服务。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SectionHeading } from "@/components/layout/PageHeader";
import { ModelRequestSettings } from "@/modules/ai/components/ModelRequestSettings";
import { isModelRefAvailable, modelRefKey } from "@/modules/ai/config";
import {
  channelModelUsageId,
  getModelUsage,
} from "@/modules/ai/lib/modelUsage";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setModelUsageModel,
  setModelUsageParameters,
} from "@/modules/settings/store";

/** 模型选择与参数修改分别保存，切换模型保留该连接其他模型的选值。 */
export function ChannelModelSettings({
  connectionId,
  disabled,
}: {
  connectionId: string;
  disabled: boolean;
}) {
  const { t } = useTranslation("channels");
  const usages = usePreferencesStore((s) => s.modelUsages);
  const definitions = usePreferencesStore((s) => s.modelParameters);
  const providerModels = usePreferencesStore((s) => s.providerModels);
  const providerBaseURLs = usePreferencesStore((s) => s.providerBaseURLs);
  const customProviders = usePreferencesStore((s) => s.customProviders);
  const defaultModel = usePreferencesStore((s) => s.defaultModel);
  const [error, setError] = useState<string | null>(null);
  const id = channelModelUsageId(connectionId);
  const usage = getModelUsage(usages, id);
  const model = usage.model ?? defaultModel;
  const models = Object.entries(providerModels).flatMap(([providerId, items]) =>
    items
      .map((item) => ({ providerId, modelId: item.id }))
      .filter((ref) =>
        isModelRefAvailable(ref, providerModels, {
          customProviders,
          providerBaseURLs,
        }),
      ),
  );
  return (
    <section className="@container mt-5 flex flex-col gap-field border-t border-border/60 pt-4">
      <SectionHeading>{t("model.title")}</SectionHeading>
      <ModelRequestSettings
        model={usage.model}
        inheritedModel={defaultModel}
        models={models}
        providerBaseURLs={providerBaseURLs}
        customProviders={customProviders}
        inheritLabel={t("model.default", {
          model: defaultModel?.modelId ?? t("model.none"),
        })}
        parameters={model ? (definitions[modelRefKey(model)] ?? []) : []}
        selections={
          model ? (usage.parameterSelections[modelRefKey(model)] ?? {}) : {}
        }
        disabled={disabled}
        onSelect={(selected) => {
          setError(null);
          void setModelUsageModel(id, selected).catch((e) =>
            setError(String(e)),
          );
        }}
        onParametersChange={(selections) => {
          if (!model) return;
          setError(null);
          void setModelUsageParameters(id, model, selections).catch((e) =>
            setError(String(e)),
          );
        }}
      />
      <p className="text-xs text-muted-foreground">{t("model.help")}</p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

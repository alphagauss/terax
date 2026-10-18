/** 按 Provider 实例分组选择模型；配置与保存由调用方提供。 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/controls/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import { ProviderIcon } from "@/modules/ai/components/ProviderIcon";
import {
  getProvider,
  modelRefKey,
  modelRefsEqual,
  resolveModel,
  tryResolveModel,
  type ModelRef,
  type ProviderBaseURLs,
  type ProviderInstance,
  type ProviderId,
  type ResolvedModel,
} from "@/modules/ai/config";
import { cn } from "@/lib/utils";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import { HugeiconsIcon } from "@hugeicons/react";

type ModelOption = { ref: ModelRef; info: ResolvedModel };
type ModelOptionGroup = {
  id: string;
  label: string;
  provider: ProviderId;
  options: ModelOption[];
};

/** 按 Provider 实例分组模型，避免多个自定义端点因共享协议而合并。 */
function resolveModelOptionGroups(
  models: readonly ModelRef[],
  providerBaseURLs: Readonly<ProviderBaseURLs>,
  customProviders: readonly ProviderInstance[],
  customFallbackLabel: string,
): ModelOptionGroup[] {
  const customById = new Map(
    customProviders.map((provider) => [provider.id, provider]),
  );
  const groups = new Map<string, ModelOptionGroup>();
  for (const ref of models) {
    const info = resolveModel(ref, { customProviders, providerBaseURLs });
    let group = groups.get(ref.providerId);
    if (!group) {
      const custom = customById.get(ref.providerId);
      group = {
        id: ref.providerId,
        label: custom
          ? custom.name.trim() || customFallbackLabel
          : getProvider(info.provider).label,
        provider: info.provider,
        options: [],
      };
      groups.set(ref.providerId, group);
    }
    group.options.push({ ref, info });
  }
  return [...groups.values()];
}

/** 渲染按 Provider 分组的模型选择器，候选集合由调用方决定。 */
export function ModelPicker({
  model,
  models,
  providerBaseURLs,
  customProviders,
  inheritLabel,
  disabled = false,
  ariaLabel,
  onSelect,
}: {
  model: ModelRef | null;
  models: readonly ModelRef[];
  providerBaseURLs: Readonly<ProviderBaseURLs>;
  customProviders: readonly ProviderInstance[];
  inheritLabel?: string;
  disabled?: boolean;
  ariaLabel?: string;
  onSelect: (model: ModelRef | null) => void;
}) {
  const { t } = useTranslation();
  const groups = useMemo(
    () =>
      resolveModelOptionGroups(
        models,
        providerBaseURLs,
        customProviders,
        t("models.providers.openaiCompatible"),
      ),
    [customProviders, models, providerBaseURLs, t],
  );
  const current = tryResolveModel(model, {
    customProviders,
    providerBaseURLs,
  });
  const hasAny = inheritLabel !== undefined || groups.length > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled || !hasAny}
          aria-label={ariaLabel}
          className="flex-1 justify-between px-2.5"
        >
          <span className="flex items-center gap-2 truncate">
            {current ? (
              <ProviderIcon provider={current.provider} size={13} />
            ) : null}
            <span className="truncate">
              {current?.label ??
                inheritLabel ??
                t("models.defaults.selectModel")}
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
          {groups.map((group) => (
            <div key={group.id} className="px-1 pt-1.5 first:pt-1">
              <div className="mb-0.5 flex items-center gap-1.5 px-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                <ProviderIcon provider={group.provider} size={11} />
                <span>{group.label}</span>
              </div>
              {group.options.map(({ ref, info }) => (
                <DropdownMenuItem
                  key={modelRefKey(ref)}
                  onSelect={() => onSelect(ref)}
                  className={cn(
                    "text-[12px]",
                    model &&
                      modelRefsEqual(ref, model) &&
                      "bg-interactive-active",
                  )}
                >
                  <span>{info.label}</span>
                </DropdownMenuItem>
              ))}
            </div>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

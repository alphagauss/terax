/**
 * 连续呈现模型及其请求参数选值，不持有模块偏好或保存逻辑。
 * 禁用时保留配置可见；参数定义与当前模型的对应关系由调用方保证。
 */
import type { ComponentProps } from "react";
import { ModelParameterReveal } from "@/modules/ai/components/ModelParameterReveal";
import {
  modelRefKey,
  modelRefsEqual,
  type ModelRef,
} from "@/modules/ai/config";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/controls/button";
import { ModelPicker } from "@/modules/ai/components/ModelPicker";
import { ModelParameterFields } from "@/modules/ai/components/ModelParameterFields";
import type {
  ModelParameter,
  ParameterSelections,
} from "@/modules/ai/lib/modelParameters";

export function ModelRequestSettings({
  parameters,
  selections,
  onParametersChange,
  inheritedModel,
  ...picker
}: ComponentProps<typeof ModelPicker> & {
  /** 未指定模型时由入口解析的实际默认模型，只用于展示与参数编辑。 */
  inheritedModel?: ModelRef | null;
  parameters: readonly ModelParameter[];
  selections: ParameterSelections;
  onParametersChange: (selections: ParameterSelections) => void;
}) {
  const { t } = useTranslation("settings");
  const effectiveModel = picker.model ?? inheritedModel;
  const modelKey = effectiveModel ? modelRefKey(effectiveModel) : null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="grid min-w-0 gap-1 @min-[30rem]:grid-cols-[7rem_minmax(0,1fr)] @min-[30rem]:items-center @min-[30rem]:gap-3">
        <span className="text-xs leading-[18px] font-medium">
          {t("models.parameters.model")}
        </span>
        <div className="flex min-w-0 [&>*]:min-w-0">
          <ModelPicker {...picker} ariaLabel={t("models.parameters.model")} />
        </div>
      </div>
      {picker.model &&
        !picker.models.some(
          (model) => picker.model && modelRefsEqual(model, picker.model),
        ) && (
          <p role="alert" className="text-xs text-destructive">
            {t("models.requestParameters.unavailableModel", {
              model: picker.model.modelId,
            })}
          </p>
        )}
      <ModelParameterReveal open={!!effectiveModel} transitionKey={modelKey}>
        {effectiveModel && (
          <div className="ml-2 flex min-w-0 flex-col gap-2 border-l border-border/60 pl-3 @min-[30rem]:ml-[7.75rem]">
            {parameters.length ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t("models.requestParameters.title")}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={
                      picker.disabled || !Object.keys(selections).length
                    }
                    onClick={() => onParametersChange({})}
                  >
                    {t("models.requestParameters.reset")}
                  </Button>
                </div>
                <ModelParameterFields
                  parameters={parameters}
                  selections={selections}
                  onChange={onParametersChange}
                  disabled={picker.disabled}
                  compact
                />
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("models.requestParameters.defaultConfiguration")}
              </p>
            )}
          </div>
        )}
      </ModelParameterReveal>
    </div>
  );
}

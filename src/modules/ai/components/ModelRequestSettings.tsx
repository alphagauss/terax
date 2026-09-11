/**
 * 连续呈现模型及其请求参数选值，不持有模块偏好或保存逻辑。
 * 禁用时保留配置可见；参数定义与当前模型的对应关系由调用方保证。
 */
import { type ComponentProps, useLayoutEffect, useRef } from "react";
import { modelRefKey, modelRefsEqual } from "@/modules/ai/config";
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
  ...picker
}: ComponentProps<typeof ModelPicker> & {
  parameters: readonly ModelParameter[];
  selections: ParameterSelections;
  onParametersChange: (selections: ParameterSelections) => void;
}) {
  const { t } = useTranslation("settings");
  const shellRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const heightAnimationRef = useRef<Animation | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const effectiveModel = picker.model;
  const modelKey = effectiveModel ? modelRefKey(effectiveModel) : null;
  const previous = useRef<{ model: string | null; height: number } | null>(
    null,
  );

  // 小型参数面板只在提交边界测量内容；先调整外壳高度，再显示原尺寸控件。
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const content = contentRef.current;
    if (!shell || !content) return;
    const height = content.getBoundingClientRect().height;
    const last = previous.current;
    previous.current = { model: modelKey, height };
    if (last?.model === modelKey && last.height === height) return;
    const from =
      heightAnimationRef.current?.playState === "running"
        ? shell.getBoundingClientRect().height
        : (last?.height ?? height);
    cleanupRef.current?.();
    if (
      !last ||
      last.model === modelKey ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;

    const style = getComputedStyle(shell);
    const duration = Number.parseFloat(style.getPropertyValue("--dur-control"));
    const feedback = Number.parseFloat(
      style.getPropertyValue("--dur-feedback"),
    );
    const easing = style.getPropertyValue("--ease-emphasized").trim();
    let fade: Animation | undefined;
    shell.style.overflow = "hidden";
    content.style.visibility = "hidden";
    content.inert = true;
    const resize = shell.animate(
      [{ height: `${from}px` }, { height: `${height}px` }],
      { duration: from === height ? 0 : duration, easing, fill: "both" },
    );
    heightAnimationRef.current = resize;
    const cleanup = () => {
      resize.onfinish = null;
      if (fade) fade.onfinish = null;
      resize.cancel();
      fade?.cancel();
      shell.style.overflow = "";
      content.style.visibility = "";
      content.inert = false;
      heightAnimationRef.current = null;
      cleanupRef.current = null;
    };
    cleanupRef.current = cleanup;
    resize.onfinish = () => {
      // 恢复自然高度和菜单溢出，不留下固定高度或不可命中的透明控件。
      resize.cancel();
      shell.style.overflow = "";
      content.style.visibility = "";
      content.inert = false;
      fade = content.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: feedback,
        easing: style.getPropertyValue("--ease-standard").trim(),
      });
      fade.onfinish = cleanup;
    };
  });

  useLayoutEffect(() => () => cleanupRef.current?.(), []);
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
      <div ref={shellRef} className="min-w-0">
        <div ref={contentRef}>
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
        </div>
      </div>
    </div>
  );
}

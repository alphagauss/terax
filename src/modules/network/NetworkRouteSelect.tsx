/**
 * 本文件提供连接级代理选择控件。
 * 只保存稳定连接身份对应的路由，缺失共享代理时明确提示，不改变其他连接。
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/controls/select";
import {
  setNetworkRoute,
  networkRoute,
  effectiveNetworkMode,
  type NetworkKey,
  useNetworkSettings,
} from "@/modules/network/settings";
import { useState } from "react";
import { LayoutFlow } from "@/components/layout/LayoutFlow";
import { reportError } from "@/lib/errors";
import { useTranslation } from "react-i18next";

/** 展示并保存一个连接的出口，保存失败时保留原值并提供翻译后的错误。 */
export function NetworkRouteSelect({
  target,
  label,
  disabled = false,
}: {
  target: NetworkKey;
  label?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation("settings");
  const routeLabel = label ?? t("network.route");
  const { values, ready, error: loadError } = useNetworkSettings();
  const [saving, setSaving] = useState(false);
  const mode = networkRoute(values[target]);
  const effective = effectiveNetworkMode(values, target);
  return (
    <div className="flex flex-col gap-1.5">
      <LayoutFlow className="flex min-w-0 items-center gap-3">
        <span className="mr-auto text-xs text-muted-foreground">
          {routeLabel}
        </span>
        {mode === "inherit" && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {t("network.effective", { mode: t(`network.${effective}`) })}
          </span>
        )}
        <Select
          value={mode}
          disabled={disabled || !ready || loadError || saving}
          onValueChange={(value) => {
            if (value !== "inherit" && value !== "direct" && value !== "shared")
              return;
            setSaving(true);
            void setNetworkRoute(target, value)
              .catch((error) =>
                reportError(t("network.saveError"), {
                  error,
                  source: routeLabel,
                }),
              )
              .finally(() => setSaving(false));
          }}
        >
          <SelectTrigger className="w-auto shrink-0" aria-label={routeLabel}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{t("network.inherit")}</SelectItem>
            <SelectItem value="direct">{t("network.direct")}</SelectItem>
            <SelectItem value="shared">{t("network.shared")}</SelectItem>
          </SelectContent>
        </Select>
      </LayoutFlow>
      {effective === "shared" && !values.proxyUrl && (
        <p className="text-xs text-destructive">{t("network.missing")}</p>
      )}
      {loadError && (
        <p className="text-xs text-destructive">{t("network.saveError")}</p>
      )}
    </div>
  );
}

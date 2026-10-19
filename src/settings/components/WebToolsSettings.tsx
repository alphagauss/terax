/** 智能体网络服务选择，逐键保存并订阅其他窗口的配置变更。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/controls/select";
import { FormField } from "@/components/layout/FormField";
import { SettingGroup } from "@/components/settings/SettingGroup";
import { reportError } from "@/lib/errors";
import { loadAgents } from "@/modules/ai/lib/agents";
import {
  onSharedStoreChange,
  readSharedStore,
  setSharedStoreKey,
} from "@/lib/sharedStore";
import {
  readWebProviders,
  WEB_SERVICE_KEYS,
  type WebProvider,
} from "@/modules/ai/web/settings";

export function WebToolsSettings() {
  const { t } = useTranslation("settings");
  const [providers, setProviders] = useState(readWebProviders({}));
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const reload = useCallback(async () => {
    const request = ++generation.current;
    try {
      const values = readWebProviders(await readSharedStore("settings"));
      if (mounted.current && request === generation.current) {
        setProviders(values);
        setReady(true);
      }
    } catch (error) {
      if (mounted.current && request === generation.current)
        reportError(t("webTools.loadError"), { error });
    }
  }, [t]);
  useEffect(() => {
    mounted.current = true;
    void reload();
    const unlisten = onSharedStoreChange("settings", reload).catch((error) => {
      if (mounted.current) reportError(t("webTools.loadError"), { error });
      return () => {};
    });
    return () => {
      mounted.current = false;
      ++generation.current;
      void unlisten.then((stop) => stop());
    };
  }, [reload, t]);
  const save = async (operation: "search" | "fetch", provider: WebProvider) => {
    setBusy(true);
    try {
      await setSharedStoreKey(
        "settings",
        WEB_SERVICE_KEYS[operation],
        provider,
      );
      await loadAgents();
      await reload();
    } catch (error) {
      reportError(t("webTools.saveError"), { error });
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingGroup title={t("webTools.title")}>
      <div className="space-y-3 p-3">
        <p className="text-xs text-muted-foreground">
          {t("webTools.description")}
        </p>
        {(["search", "fetch"] as const).map((operation) => (
          <FormField
            key={operation}
            htmlFor={`web-${operation}`}
            label={t(`webTools.${operation}`)}
          >
            <Select
              value={providers[operation]}
              disabled={!ready || busy}
              onValueChange={(value) => {
                if (value === "disabled" || value === "deepseek")
                  void save(operation, value);
              }}
            >
              <SelectTrigger id={`web-${operation}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="disabled">
                  {t("webTools.disabled")}
                </SelectItem>
                <SelectItem value="deepseek">DeepSeek</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
        ))}
        <p className="text-xs text-muted-foreground">
          {t("webTools.connection")}
        </p>
      </div>
    </SettingGroup>
  );
}

/**
 * 本文件实现常规设置中的共享代理设置组。
 * 地址通过原生校验后保存，密码单独写入秘密存储，配置不会全局启用代理。
 */
import { reportError } from "@/lib/errors";
import { Button } from "@/components/controls/button";
import { Input } from "@/components/controls/input";
import { FormField } from "@/components/layout/FormField";
import { SettingGroup } from "@/components/settings/SettingGroup";
import { setSharedStoreKey } from "@/lib/sharedStore";
import { NetworkRouteSelect } from "@/modules/network/NetworkRouteSelect";
import { useNetworkSettings } from "@/modules/network/settings";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/** 编辑共享代理地址和可选密码；空密码保持现值，清除操作单独提供。 */
export function NetworkSettings() {
  const { t } = useTranslation("settings");
  const { values, ready, error: loadError } = useNetworkSettings();
  const currentUrl = typeof values.proxyUrl === "string" ? values.proxyUrl : "";
  const [url, setUrl] = useState(currentUrl);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<"saved" | null>(null);
  useEffect(() => setUrl(currentUrl), [currentUrl]);
  const save = async (clearPassword = false) => {
    setBusy(true);
    setMessage(null);
    try {
      if (clearPassword) {
        const account = await invoke<string>("network_validate_proxy", {
          url: currentUrl,
        });
        await invoke("secrets_delete", {
          service: "terax-network",
          account,
        });
        setPassword("");
        setMessage("saved");
        return;
      }
      const account = url.trim()
        ? await invoke<string>("network_validate_proxy", { url: url.trim() })
        : null;
      if (password) {
        if (!new URL(url.trim()).username) throw new Error("username required");
        await invoke("secrets_set", {
          service: "terax-network",
          account,
          password,
        });
      }
      await setSharedStoreKey("settings", "network.proxyUrl", url.trim());
      setPassword("");
      setMessage("saved");
    } catch (error) {
      reportError(t("network.saveError"), { error });
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingGroup title={t("network.title")}>
      <form
        className="flex flex-col gap-field p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="text-[11px] leading-4 text-muted-foreground">
          {t("network.description")}
        </p>
        <FormField
          htmlFor="network-proxy-url"
          label={t("network.url")}
          description={t("network.urlHint")}
        >
          <Input
            id="network-proxy-url"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setMessage(null);
            }}
            placeholder="http://127.0.0.1:7890"
            spellCheck={false}
            disabled={busy || !ready}
          />
        </FormField>
        <FormField
          htmlFor="network-proxy-password"
          label={t("network.password")}
        >
          <Input
            id="network-proxy-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setMessage(null);
            }}
            placeholder={t("network.passwordHint")}
            disabled={busy || !ready}
          />
        </FormField>
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !ready || loadError}>
            {t("network.save")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !ready || loadError || !currentUrl}
            onClick={() => void save(true)}
          >
            {t("network.clearPassword")}
          </Button>
        </div>
        {(message || loadError) && (
          <p
            role="status"
            className={
              message === "saved" && !loadError
                ? "text-xs text-muted-foreground"
                : "text-xs text-destructive"
            }
          >
            {t(`network.${loadError ? "saveError" : message}`)}
          </p>
        )}
      </form>
      <div className="px-3 py-2">
        <NetworkRouteSelect target="markdown" label={t("network.images")} />
      </div>
      <p className="px-3 py-2 text-[11px] leading-4 text-muted-foreground">
        {t("network.scope")}
      </p>
    </SettingGroup>
  );
}

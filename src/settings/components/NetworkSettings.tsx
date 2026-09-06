/**
 * 本文件实现常规设置中的共享代理设置组。
 * 地址通过原生校验后保存，密码单独写入秘密存储，配置不会全局启用代理。
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  const [message, setMessage] = useState<"saved" | "saveError" | null>(null);
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
    } catch {
      setMessage("saveError");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby="network-settings-title"
    >
      <h3
        id="network-settings-title"
        className="text-[11px] font-medium tracking-tight text-muted-foreground"
      >
        {t("network.title")}
      </h3>
      <form
        className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/60 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="text-[10.5px] leading-relaxed text-muted-foreground">
          {t("network.description")}
        </p>
        <label
          htmlFor="network-proxy-url"
          className="flex flex-col gap-1.5 text-[11.5px]"
        >
          {t("network.url")}
          <Input
            id="network-proxy-url"
            className="h-8 text-[12px]"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setMessage(null);
            }}
            placeholder="http://127.0.0.1:7890"
            spellCheck={false}
            disabled={busy || !ready}
          />
        </label>
        <p className="text-[10.5px] leading-relaxed text-muted-foreground">
          {t("network.urlHint")}
        </p>
        <label
          htmlFor="network-proxy-password"
          className="flex flex-col gap-1.5 text-[11.5px]"
        >
          {t("network.password")}
          <Input
            id="network-proxy-password"
            className="h-8 text-[12px]"
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
        </label>
        <div className="flex gap-2">
          <Button
            size="sm"
            className="text-[12px]"
            type="submit"
            disabled={busy || !ready || loadError}
          >
            {t("network.save")}
          </Button>
          <Button
            size="sm"
            className="text-[12px]"
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
      <div className="rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
        <NetworkRouteSelect target="markdown" label={t("network.images")} />
      </div>
      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        {t("network.scope")}
      </p>
    </section>
  );
}

/**
 * 本文件实现设置中的 Channels 管理页。
 * 设置 WebView 仅订阅主窗口快照和发送管理请求，二维码渲染按需加载。
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/controls/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  type ChannelAction,
  requestChannels,
  subscribeChannelsView,
  useChannelsView,
} from "@/modules/channels/client";
import { ConnectionStatus } from "@/modules/channels/components/ConnectionStatus";
import type { ChannelSnapshot } from "@/modules/channels/types";
import {
  spawnWorkspaceProcess,
  type WorkspaceBootstrap,
} from "@/modules/workspace-process";
import { SectionHeader } from "@/settings/components/SectionHeader";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** 展示连接管理与微信授权流程，不依赖主窗口的 React 实例。 */
export function ChannelsSection() {
  const { t } = useTranslation("channels");
  const snapshots = useChannelsView((state) => state.snapshots);
  const serviceError = useChannelsView((state) => state.error);
  const [owner, setOwner] = useState<boolean | null>(null);
  const [ready, setReady] = useState(false);
  const [retry, setRetry] = useState(0);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 重试版本用于重新建立服务订阅，清理失效监听。
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void invoke<WorkspaceBootstrap>("get_workspace_bootstrap")
      .then(async (bootstrap) => {
        if (disposed) return;
        const local = bootstrap.isPrimary && bootstrap.env.kind === "local";
        setOwner(local);
        if (!local) return;
        unsubscribe = await subscribeChannelsView();
        if (disposed) unsubscribe();
        else setReady(true);
      })
      .catch(() => {
        if (!disposed) setError("unavailable");
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [retry]);

  const run = async (action: ChannelAction) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await requestChannels(action);
      if (action.action === "add") setName("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "unavailable");
    } finally {
      setBusy(false);
    }
  };

  const message = error ?? serviceError;
  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("description")} />
      {owner === false ? (
        <div className="flex flex-col gap-3 text-sm text-muted-foreground">
          <p>{t("localOnly")}</p>
          <Button
            variant="outline"
            className="self-start"
            onClick={() => {
              void spawnWorkspaceProcess({ kind: "local" }, "recent").catch(
                () => setError("unavailable"),
              );
            }}
          >
            {t("openLocal")}
          </Button>
        </div>
      ) : (
        <>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("defaults")}
          </p>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run({
                action: "add",
                name: name.trim() || t("defaultName"),
              });
            }}
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder={t("namePlaceholder")}
              aria-label={t("namePlaceholder")}
              disabled={!ready || busy}
            />
            <Button variant="outline" type="submit" disabled={!ready || busy}>
              {t("addWeixin")}
            </Button>
          </form>
          {!ready && !message ? (
            <p className="text-sm text-muted-foreground">{t("loading")}</p>
          ) : null}
          {ready && !snapshots.length ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              {t("empty")}
            </div>
          ) : null}
          <div className="flex flex-col gap-3">
            {snapshots.map((snapshot) => (
              <ConnectionCard
                key={snapshot.connection.id}
                snapshot={snapshot}
                disabled={busy}
                run={run}
              />
            ))}
          </div>
        </>
      )}
      {!ready && owner !== false && message ? (
        <Button
          variant="outline"
          className="self-start"
          onClick={() => {
            setError(null);
            setRetry((value) => value + 1);
          }}
        >
          {t("reconnect")}
        </Button>
      ) : null}
      {message ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${message}`, { defaultValue: t("errors.unavailable") })}
        </p>
      ) : null}
    </div>
  );
}

/** 单连接的启停、登录和会话导航，删除仅移除连接配置与凭据。 */
function ConnectionCard({
  snapshot,
  disabled,
  run,
}: {
  snapshot: ChannelSnapshot;
  disabled: boolean;
  run: (action: ChannelAction) => Promise<void>;
}) {
  const { t } = useTranslation("channels");
  const [code, setCode] = useState("");
  const { connection, login } = snapshot;
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-sm font-medium">
            {connection.name}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {t("weixin")}
            {connection.accountId ? ` · ${connection.accountId}` : ""}
          </span>
          <ConnectionStatus snapshot={snapshot} />
        </div>
        <Switch
          checked={connection.enabled}
          disabled={disabled || !connection.accountId}
          aria-label={t("enable", { name: connection.name })}
          onCheckedChange={(enabled) => {
            void run({ action: "enable", id: connection.id, enabled });
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {t("busyMessageMode.label")}
        </span>
        <Select
          value={connection.busyMessageMode}
          disabled={disabled || snapshot.busy}
          onValueChange={(mode) => {
            if (mode === "steer" || mode === "queue")
              void run({
                action: "busy-message-mode",
                id: connection.id,
                mode,
              });
          }}
        >
          <SelectTrigger
            aria-label={t("busyMessageMode.label")}
            className="w-auto"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="steer">{t("busyMessageMode.steer")}</SelectItem>
            <SelectItem value="queue">{t("busyMessageMode.queue")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {snapshot.issue ? (
        <p className="text-xs text-destructive">
          {t(`errors.${snapshot.issue}`)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || Boolean(login && login.state !== "expired")}
          onClick={() => {
            void run({ action: "login", id: connection.id });
          }}
        >
          {connection.accountId ? t("loginAgain") : t("login")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            void run({ action: "open", id: connection.id });
          }}
        >
          {t("openSession")}
        </Button>
        {connection.enabled ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || snapshot.busy}
            onClick={() => {
              void run({ action: "reconnect", id: connection.id });
            }}
          >
            {t("reconnect")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || connection.enabled || snapshot.busy}
          className="ml-auto text-muted-foreground"
          title={t("removeHint")}
          onClick={() => {
            void run({ action: "remove", id: connection.id });
          }}
        >
          {t("remove")}
        </Button>
      </div>
      {login ? (
        <div className="flex flex-col items-center gap-3 rounded-md bg-muted/40 p-4">
          {login.state !== "expired" ? (
            <LoginQr content={login.qrContent} />
          ) : null}
          <p className="text-center text-xs text-muted-foreground">
            {t(`loginState.${login.state}`)}
          </p>
          {login.state === "verify" ? (
            <form
              className="flex w-full max-w-64 gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run({ action: "verify", id: connection.id, code }).then(
                  () => setCode(""),
                );
              }}
            >
              <Input
                value={code}
                inputMode="numeric"
                maxLength={8}
                onChange={(event) =>
                  setCode(event.target.value.replace(/\D/g, ""))
                }
                placeholder={t("verification")}
                aria-label={t("verification")}
              />
              <Button size="sm" type="submit" disabled={disabled || !code}>
                {t("confirm")}
              </Button>
            </form>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              void run({ action: "cancel-login", id: connection.id });
            }}
          >
            {t("cancel")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** 在本地生成二维码，扫码内容不会发送到第三方图片服务。 */
function LoginQr({ content }: { content: string }) {
  const { t } = useTranslation("channels");
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    setFailed(false);
    void import("qrcode")
      .then(async (qr) => {
        if (!disposed && canvas.current)
          await qr.toCanvas(canvas.current, content, { width: 220, margin: 3 });
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [content]);
  return failed ? (
    <p className="text-xs text-destructive">{t("errors.protocol")}</p>
  ) : (
    <canvas
      ref={canvas}
      role="img"
      aria-label={t("qrLabel")}
      className="rounded-md"
    />
  );
}

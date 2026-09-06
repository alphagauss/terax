/**
 * 本文件管理单实例的配置编辑、显式保存、扫码和运行操作。
 * 草稿由父页面按实例保留；配置和网络路由分别提交，二维码库仅在授权时加载。
 */

import { FormField } from "@/components/layout/FormField";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/controls/select";
import { Button } from "@/components/controls/button";
import { Input } from "@/components/controls/input";
import { Switch } from "@/components/ui/switch";
import { requestChannels, type ChannelAction } from "@/modules/channels/client";
import { ConnectionStatus } from "@/modules/channels/components/ConnectionStatus";
import type {
  ChannelConnection,
  ChannelSnapshot,
} from "@/modules/channels/types";
import {
  setNetworkRoute,
  useNetworkSettings,
  type ProxyMode,
} from "@/modules/network/settings";
import { ConnectionSettingsActions } from "@/settings/components/ConnectionSettingsLayout";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type ChannelDraft = {
  name: string;
  mode: ChannelConnection["busyMessageMode"];
  route: ProxyMode;
};

/** 实例详情表单，实时快照不覆盖用户草稿，失效授权可在原位重试。 */
export function ChannelConnectionEditor({
  snapshot,
  edits,
  loginPending,
  disabled,
  error,
  updateDraft,
  run,
  perform,
}: {
  snapshot: ChannelSnapshot;
  edits?: Partial<ChannelDraft>;
  loginPending: boolean;
  disabled: boolean;
  error?: string;
  updateDraft: (id: string, patch?: Partial<ChannelDraft>) => void;
  perform: (id: string, work: () => Promise<void>) => Promise<boolean>;
  run: (action: ChannelAction) => Promise<boolean>;
}) {
  const { t } = useTranslation("channels");
  const { connection, login } = snapshot;
  const network = useNetworkSettings();
  const route: ProxyMode =
    network.values[`channel:${connection.id}`] === "shared"
      ? "shared"
      : "direct";
  const draft = {
    name: connection.name,
    mode: connection.busyMessageMode,
    route,
    ...edits,
  };
  const configChanged =
    draft.name.trim() !== connection.name ||
    draft.mode !== connection.busyMessageMode;
  const dirty = configChanged || draft.route !== route;
  const invalidName = !draft.name.trim() || draft.name.trim().length > 80;
  const message = error ?? snapshot.issue;

  /** 两个权威存储分别提交；部分失败保留草稿，重试只写仍有差异的部分。 */
  const save = () => {
    if (disabled || invalidName || !dirty) return;
    void perform(connection.id, async () => {
      if (configChanged)
        await requestChannels({
          action: "update",
          id: connection.id,
          name: draft.name,
          mode: draft.mode,
        });
      if (draft.route !== route) {
        try {
          await setNetworkRoute(`channel:${connection.id}`, draft.route);
        } catch {
          throw new Error("route-save");
        }
      }
      updateDraft(connection.id);
    });
  };

  const remove = async () => {
    if (!window.confirm(t("removeConfirm", { name: connection.name }))) return;
    if (await run({ action: "remove", id: connection.id }))
      updateDraft(connection.id);
  };
  return (
    <>
      <div className="mb-5 flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 className="text-[13px] font-medium">{t(connection.kind)}</h2>
          <ConnectionStatus snapshot={snapshot} />
          {connection.accountId ? (
            <p className="break-all text-[11px] text-muted-foreground">
              {connection.accountId}
            </p>
          ) : null}
        </div>
        <label
          htmlFor={`channel-enabled-${connection.id}`}
          className="flex shrink-0 items-center gap-2 text-[12px]"
        >
          <span>{t("enabled")}</span>
          <Switch
            id={`channel-enabled-${connection.id}`}
            checked={connection.enabled}
            disabled={disabled || !connection.accountId}
            aria-label={t("enable", { name: connection.name })}
            onCheckedChange={(enabled) =>
              void run({ action: "enable", id: connection.id, enabled })
            }
          />
        </label>
      </div>
      {login ? (
        <div className="mb-5">
          <ChannelLogin
            key={connection.id}
            snapshot={snapshot}
            disabled={disabled}
            run={run}
          />
        </div>
      ) : null}
      {loginPending && !login ? (
        <p
          role="status"
          className="mb-5 rounded-lg bg-muted/40 p-4 text-center text-[12px] text-muted-foreground"
        >
          {t("preparingQr")}
        </p>
      ) : null}
      {message ? (
        <p
          role="alert"
          className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
        >
          {t(`errors.${message}`, { defaultValue: t("errors.unavailable") })}
        </p>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) save();
        }}
      >
        <div className="grid gap-4">
          <FormField label={t("namePlaceholder")}>
            <Input
              aria-label={t("namePlaceholder")}
              value={draft.name}
              maxLength={80}
              disabled={disabled}
              aria-invalid={invalidName}
              onChange={(event) =>
                updateDraft(connection.id, { name: event.target.value })
              }
            />
            {invalidName ? (
              <p className="text-[11px] text-destructive">{t("errors.name")}</p>
            ) : null}
          </FormField>
          <FormField label={t("busyMessageMode.label")}>
            <Select
              value={draft.mode}
              disabled={disabled || snapshot.busy}
              onValueChange={(mode) => {
                if (mode === "steer" || mode === "queue")
                  updateDraft(connection.id, { mode });
              }}
            >
              <SelectTrigger
                className="w-full"
                aria-label={t("busyMessageMode.label")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="steer">
                  {t("busyMessageMode.steer")}
                </SelectItem>
                <SelectItem value="queue">
                  {t("busyMessageMode.queue")}
                </SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField label={t("settings:network.route")}>
            <Select
              value={draft.route}
              disabled={disabled || !network.ready || network.error}
              onValueChange={(value) => {
                if (value === "direct" || value === "shared")
                  updateDraft(connection.id, { route: value });
              }}
            >
              <SelectTrigger
                className="w-full"
                aria-label={t("settings:network.route")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="direct">
                  {t("settings:network.direct")}
                </SelectItem>
                <SelectItem value="shared">
                  {t("settings:network.shared")}
                </SelectItem>
              </SelectContent>
            </Select>
            {draft.route === "shared" && !network.values.proxyUrl ? (
              <p className="text-[11px] text-destructive">
                {t("settings:network.missing")}
              </p>
            ) : null}
            {network.error ? (
              <p role="alert" className="text-[11px] text-destructive">
                {t("settings:network.saveError")}
              </p>
            ) : null}
          </FormField>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {connection.accountId ? (
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => void run({ action: "open", id: connection.id })}
            >
              {t("openSession")}
            </Button>
          ) : null}
          {!login ? (
            <Button
              type="button"
              variant={connection.accountId ? "ghost" : "outline"}
              disabled={disabled}
              onClick={() => void run({ action: "login", id: connection.id })}
            >
              {connection.accountId ? t("loginAgain") : t("login")}
            </Button>
          ) : null}
          {connection.enabled &&
          (snapshot.issue ||
            snapshot.status === "error" ||
            snapshot.status === "reconnecting") ? (
            <Button
              type="button"
              variant="ghost"
              disabled={disabled || snapshot.busy}
              onClick={() =>
                void run({ action: "reconnect", id: connection.id })
              }
            >
              {t("reconnect")}
            </Button>
          ) : null}
        </div>
        <ConnectionSettingsActions>
          <Button
            type="button"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            disabled={disabled || connection.enabled || snapshot.busy}
            title={t("removeHint")}
            onClick={remove}
          >
            {t("remove")}
          </Button>
          <span className="flex-1" />
          <Button type="submit" disabled={disabled || !dirty || invalidName}>
            {t("save")}
          </Button>
        </ConnectionSettingsActions>
      </form>
    </>
  );
}

/** 展示当前登录阶段；仅提交成功后清空验证码，失败时保留输入供重试。 */
function ChannelLogin({
  snapshot,
  disabled,
  run,
}: {
  snapshot: ChannelSnapshot;
  disabled: boolean;
  run: (action: ChannelAction) => Promise<boolean>;
}) {
  const { t } = useTranslation("channels");
  const [code, setCode] = useState("");
  const { connection, login } = snapshot;
  if (!login) return null;
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg bg-muted/40 p-4">
      {login.state !== "expired" ? <LoginQr content={login.qrContent} /> : null}
      <p
        className="text-center text-[12px] text-muted-foreground"
        role="status"
      >
        {t(`loginState.${login.state}`)}
      </p>
      {login.state === "verify" ? (
        <form
          className="flex w-full max-w-64 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run({ action: "verify", id: connection.id, code }).then(
              (saved) => {
                if (saved) setCode("");
              },
            );
          }}
        >
          <Input
            value={code}
            inputMode="numeric"
            maxLength={8}
            disabled={disabled}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            placeholder={t("verification")}
            aria-label={t("verification")}
          />
          <Button type="submit" disabled={disabled || !code}>
            {t("confirm")}
          </Button>
        </form>
      ) : null}
      {login.state === "expired" ? (
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() => void run({ action: "login", id: connection.id })}
        >
          {t("refreshQr")}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        disabled={disabled}
        onClick={() => void run({ action: "cancel-login", id: connection.id })}
      >
        {t("cancel")}
      </Button>
    </div>
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

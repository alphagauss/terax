/**
 * 本文件实现 SSH profile 的持久化隧道管理面板。
 * 配置保存到 profile，启用项在连接后自动启动；运行时状态仅用于展示和单条重启。
 */

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  emptyTunnelForm,
  savedTunnelFromForm,
  tunnelConfigFromForm,
  tunnelDisplayName,
  tunnelFormFromSaved,
  tunnelValidationIssue,
  type TunnelForm,
} from "./tunnelForm";
import { remoteNative } from "./native";
import type { SshTunnel, TunnelInfo, TunnelStatus } from "./types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profileId: string;
  profileName: string;
  tunnels: SshTunnel[];
  runtimeTunnels: TunnelInfo[];
  lifecycleError: string | null;
  saveTunnels: (tunnels: SshTunnel[]) => Promise<void>;
  refresh: () => Promise<void>;
};

/** 显示和修改单个 SSH profile 的持久化隧道。 */
export function TunnelManagerDialog({
  open,
  onOpenChange,
  profileId,
  profileName,
  tunnels,
  runtimeTunnels,
  lifecycleError,
  saveTunnels,
  refresh,
}: Props) {
  const { t } = useTranslation("statusbar");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<TunnelForm>(emptyTunnelForm);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedTunnel = tunnels.find((tunnel) => tunnel.id === selectedId);
  const runtimeByConfigId = useMemo(
    () => new Map(runtimeTunnels.map((tunnel) => [tunnel.configId, tunnel])),
    [runtimeTunnels],
  );
  const selectedRuntime = selectedId
    ? runtimeByConfigId.get(selectedId)
    : undefined;
  const visibleError = error ?? selectedRuntime?.error ?? lifecycleError;

  useEffect(() => {
    if (!open) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      await refresh();
      if (active) timer = window.setTimeout(() => void poll(), 1_000);
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [open, refresh]);

  useEffect(() => {
    if (selectedId && !tunnels.some((tunnel) => tunnel.id === selectedId)) {
      setSelectedId(null);
      setForm(emptyTunnelForm());
      setEnabled(true);
      setError(null);
    }
  }, [selectedId, tunnels]);

  const update = <K extends keyof TunnelForm>(key: K, value: TunnelForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const selectTunnel = (tunnel: SshTunnel) => {
    setSelectedId(tunnel.id);
    setForm(tunnelFormFromSaved(tunnel));
    setEnabled(tunnel.enabled);
    setError(null);
  };

  const startNew = () => {
    setSelectedId(null);
    setForm(emptyTunnelForm());
    setEnabled(true);
    setError(null);
  };

  /** 保存配置后只重启当前条目，失败时回滚配置写入。 */
  const save = async () => {
    const issue = tunnelValidationIssue(form);
    if (issue) {
      setError(t(`tunnels.validation.${issue}`));
      return;
    }
    const id = selectedId ?? crypto.randomUUID();
    const nextTunnel = savedTunnelFromForm(form, id, enabled);
    const nextTunnels = [
      ...tunnels.filter((tunnel) => tunnel.id !== id),
      nextTunnel,
    ];
    setBusy(true);
    setError(null);
    try {
      await saveTunnels(nextTunnels);
      if (enabled) {
        const config = tunnelConfigFromForm(form, profileId, id);
        if (selectedRuntime) {
          await remoteNative.updateTunnel(selectedRuntime.id, config);
        } else {
          await remoteNative.startTunnel(config);
        }
      } else if (selectedRuntime) {
        await remoteNative.stopTunnel(selectedRuntime.id);
      }
      setSelectedId(id);
      await refresh();
    } catch (cause) {
      // 新建隧道启动失败时保留配置，方便用户查看失败状态并修正后重试。
      if (selectedTunnel) {
        await saveTunnels(tunnels).catch(() => {});
      } else {
        setSelectedId(id);
      }
      setError(String(cause));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  /** 删除持久化配置前先停止该配置当前持有的网络资源。 */
  const remove = async () => {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      if (selectedRuntime) await remoteNative.stopTunnel(selectedRuntime.id);
      await saveTunnels(tunnels.filter((tunnel) => tunnel.id !== selectedId));
      startNew();
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const submitLabel = selectedTunnel
    ? enabled
      ? t("tunnels.saveRestart")
      : t("tunnels.save")
    : enabled
      ? t("tunnels.saveStart")
      : t("tunnels.save");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid h-[min(42rem,calc(100vh-3rem))] w-[min(48rem,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="border-b border-border/60 px-5 py-4">
          <DialogTitle>{t("tunnels.title")}</DialogTitle>
          <DialogDescription>
            {t("tunnels.description", { name: profileName })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 md:grid-cols-[14rem_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-b border-border/60 bg-muted/20 md:border-r md:border-b-0">
            <div className="border-b border-border/60 p-3">
              <Button
                size="sm"
                className="w-full"
                disabled={busy}
                onClick={startNew}
              >
                {t("tunnels.new")}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {tunnels.length === 0 ? (
                <p className="px-2 py-4 text-[11px] text-muted-foreground">
                  {t("tunnels.empty")}
                </p>
              ) : (
                tunnels.map((tunnel) => {
                  const runtime = runtimeByConfigId.get(tunnel.id);
                  const status: TunnelStatus = runtime?.status ?? "closed";
                  return (
                    <button
                      key={tunnel.id}
                      type="button"
                      disabled={busy}
                      onClick={() => selectTunnel(tunnel)}
                      className={cn(
                        "mb-1 w-full rounded-md px-2.5 py-2 text-left hover:bg-accent",
                        selectedId === tunnel.id && "bg-accent",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-[12px] font-medium">
                          {tunnelDisplayName(runtime ?? tunnel)}
                        </span>
                        <StatusDot status={status} label={t(`tunnels.status.${status}`)} />
                      </span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">
                        {tunnel.kind === "local"
                          ? t("tunnels.local")
                          : tunnel.kind === "remote"
                            ? t("tunnels.remote")
                            : t("tunnels.dynamic")}{" "}
                        {tunnel.bindHost}:{tunnel.bindPort}
                        {tunnel.kind !== "dynamic"
                          ? ` → ${tunnel.targetHost}:${tunnel.targetPort}`
                          : null}
                      </span>
                      {runtime?.error ? (
                        <span className="block truncate text-[10px] text-destructive">
                          {runtime.error}
                        </span>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <section className="min-h-0 overflow-y-auto p-5">
            <h2 className="mb-4 text-[13px] font-medium">
              {selectedId ? t("tunnels.editTunnel") : t("tunnels.newTunnel")}
            </h2>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("tunnels.name")} className="sm:col-span-2">
                <Input
                  value={form.name}
                  onChange={(event) => update("name", event.target.value)}
                  disabled={busy}
                  placeholder={t("tunnels.namePlaceholder")}
                />
              </Field>
              <Field label={t("tunnels.type")}>
                <select
                  value={form.kind}
                  onChange={(event) =>
                    update("kind", event.target.value as TunnelForm["kind"])
                  }
                  disabled={busy}
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                >
                  <option value="local">{t("tunnels.local")}</option>
                  <option value="remote">{t("tunnels.remote")}</option>
                  <option value="dynamic">{t("tunnels.dynamic")}</option>
                </select>
              </Field>
              <Field label={t("tunnels.bindAddress")}>
                <Input
                  value={form.bindHost}
                  onChange={(event) => update("bindHost", event.target.value)}
                  disabled={busy}
                  spellCheck={false}
                />
              </Field>
              <Field label={t("tunnels.bindPort")}>
                <Input
                  type="number"
                  min={0}
                  max={65535}
                  value={form.bindPort}
                  onChange={(event) => update("bindPort", event.target.value)}
                  disabled={busy}
                />
              </Field>
              {form.kind !== "dynamic" ? (
                <>
                  <Field label={t("tunnels.targetHost")}>
                    <Input
                      value={form.targetHost}
                      onChange={(event) => update("targetHost", event.target.value)}
                      disabled={busy}
                      spellCheck={false}
                    />
                  </Field>
                  <Field label={t("tunnels.targetPort")}>
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      value={form.targetPort}
                      onChange={(event) => update("targetPort", event.target.value)}
                      disabled={busy}
                    />
                  </Field>
                </>
              ) : null}
            </div>

            <div className="mt-4 flex items-center gap-2">
              <Switch
                id="ssh-tunnel-enabled"
                size="sm"
                checked={enabled}
                disabled={busy}
                onCheckedChange={setEnabled}
              />
              <Label htmlFor="ssh-tunnel-enabled" className="text-[11px] font-normal">
                {t("tunnels.enabled")}
              </Label>
            </div>
            <p className="mt-1 text-[10.5px] text-muted-foreground">
              {t("tunnels.enabledHint")}
            </p>

            {selectedRuntime ? (
              <p className="mt-4 text-[10.5px] text-muted-foreground">
                {t("tunnels.traffic", {
                  bytes: formatBytes(selectedRuntime.bytes),
                })}
              </p>
            ) : null}
            {visibleError ? (
              <p className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
                {visibleError}
              </p>
            ) : null}

            <div className="mt-5 flex items-center gap-2 border-t border-border/60 pt-4">
              {selectedId ? (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  {t("tunnels.remove")}
                </Button>
              ) : null}
              <div className="flex-1" />
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                {submitLabel}
              </Button>
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 在名称右侧呈现可访问的运行状态，不重复在编辑区展示。 */
function StatusDot({ status, label }: { status: TunnelStatus; label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status === "active"
          ? "bg-emerald-500"
          : status === "failed"
            ? "bg-destructive"
            : "bg-muted-foreground/45",
      )}
    />
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid min-w-0 gap-1.5", className)}>
      <Label className="text-[10.5px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

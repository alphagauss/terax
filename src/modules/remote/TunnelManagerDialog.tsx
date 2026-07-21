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
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  emptyTunnelForm,
  tunnelConfigFromForm,
  tunnelFormFrom,
  tunnelValidationIssue,
  type TunnelForm,
} from "./tunnelForm";
import { remoteNative } from "./native";
import type { TunnelInfo } from "./types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profileId: string;
  profileName: string;
  tunnels: TunnelInfo[];
  lifecycleError: string | null;
  refresh: () => Promise<void>;
};

export function TunnelManagerDialog({
  open,
  onOpenChange,
  profileId,
  profileName,
  tunnels,
  lifecycleError,
  refresh,
}: Props) {
  const { t } = useTranslation("statusbar");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState<TunnelForm>(emptyTunnelForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedTunnel = tunnels.find((tunnel) => tunnel.id === selectedId);
  const visibleError = error ?? selectedTunnel?.error ?? lifecycleError;

  useEffect(() => {
    if (!open) return;
    let active = true;
    let timer: number | undefined;
    setError(null);
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
    }
  }, [selectedId, tunnels]);

  const update = <K extends keyof TunnelForm>(key: K, value: TunnelForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const selectTunnel = (tunnel: TunnelInfo) => {
    setSelectedId(tunnel.id);
    setForm(tunnelFormFrom(tunnel));
    setError(null);
  };

  const startNew = () => {
    setSelectedId(null);
    setForm(emptyTunnelForm());
    setError(null);
  };

  const save = async () => {
    const issue = tunnelValidationIssue(form);
    if (issue) {
      setError(t(`tunnels.validation.${issue}`));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const config = tunnelConfigFromForm(form, profileId);
      const tunnel = selectedId
        ? await remoteNative.updateTunnel(selectedId, config)
        : await remoteNative.startTunnel(config);
      setSelectedId(tunnel.id);
      setForm(tunnelFormFrom(tunnel));
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await remoteNative.stopTunnel(selectedId);
      startNew();
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

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
                tunnels.map((tunnel) => (
                  <button
                    key={tunnel.id}
                    type="button"
                    disabled={busy}
                    onClick={() => selectTunnel(tunnel)}
                    className={cn(
                      "mb-1 w-full rounded-md px-2.5 py-2 text-left hover:bg-accent",
                      selectedId === tunnel.id && "bg-accent",
                      (tunnel.status === "failed" || tunnel.error) &&
                        "text-destructive",
                    )}
                  >
                    <span className="block truncate text-[12px] font-medium">
                      {tunnel.name}
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
                    <span className="block text-[10px] text-muted-foreground">
                      {t(`tunnels.status.${tunnel.status}`)} ·{" "}
                      {formatBytes(tunnel.bytes)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </aside>

          <section className="min-h-0 overflow-y-auto p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-[13px] font-medium">
                {selectedId ? t("tunnels.editTunnel") : t("tunnels.newTunnel")}
              </h2>
              {selectedTunnel ? (
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px]",
                    selectedTunnel.status === "active"
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                      : selectedTunnel.status === "failed"
                        ? "bg-destructive/10 text-destructive"
                        : "bg-muted text-muted-foreground",
                  )}
                >
                  {t(`tunnels.status.${selectedTunnel.status}`)}
                </span>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("tunnels.name")} className="sm:col-span-2">
                <Input
                  value={form.name}
                  onChange={(event) => update("name", event.target.value)}
                  disabled={busy}
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
                      onChange={(event) =>
                        update("targetHost", event.target.value)
                      }
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
                      onChange={(event) =>
                        update("targetPort", event.target.value)
                      }
                      disabled={busy}
                    />
                  </Field>
                </>
              ) : null}
            </div>

            {selectedTunnel ? (
              <p className="mt-4 text-[10.5px] text-muted-foreground">
                {t("tunnels.traffic", {
                  bytes: formatBytes(selectedTunnel.bytes),
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
                  {t("tunnels.stopRemove")}
                </Button>
              ) : null}
              <div className="flex-1" />
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                {selectedId ? t("tunnels.applyRestart") : t("tunnels.start")}
              </Button>
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
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

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { remoteNative, useRemoteStore } from "@/modules/remote";
import {
  applyCredentialMutation,
  credentialMutation,
  emptySshProfileForm,
  launchSecretIssue,
  profileValidationIssue,
  sshProfileFormFrom,
  sshProfileFromForm,
  type SshProfileForm,
} from "@/modules/remote/profileForm";
import type { SshProfile } from "@/modules/remote/types";
import { newProfileId } from "@/modules/remote/store";
import { spawnWorkspaceProcess } from "@/modules/workspace-process";
import {
  Add01Icon,
  Download01Icon,
  FloppyDiskIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { SectionHeader } from "../components/SectionHeader";

export function RemoteSection() {
  const { t } = useTranslation("settings");
  const profiles = useRemoteStore((state) => state.profiles);
  const load = useRemoteStore((state) => state.load);
  const saveProfile = useRemoteStore((state) => state.saveProfile);
  const saveProfiles = useRemoteStore((state) => state.saveProfiles);
  const deleteProfile = useRemoteStore((state) => state.deleteProfile);
  const [form, setForm] = useState<SshProfileForm>(() =>
    emptySshProfileForm(newProfileId()),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newDraft, setNewDraft] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectionRevision = useRef(0);

  const selected = useMemo(
    () => profiles.find((profile) => profile.id === selectedId) ?? null,
    [profiles, selectedId],
  );

  const selectProfile = useCallback(async (profile: SshProfile) => {
    const revision = ++selectionRevision.current;
    setSelectedId(profile.id);
    setNewDraft(false);
    setForm(sshProfileFormFrom(profile));
    setError(null);
    try {
      const [secret, proxySecret] = await Promise.all([
        remoteNative.getSecret(profile.id),
        remoteNative.getProxySecret(profile.id),
      ]);
      if (selectionRevision.current !== revision) return;
      setForm((current) =>
        current.id === profile.id
          ? {
              ...current,
              secret: current.secretDirty ? current.secret : (secret ?? ""),
              proxySecret: current.proxySecretDirty
                ? current.proxySecret
                : (proxySecret ?? ""),
            }
          : current,
      );
    } catch (cause) {
      if (selectionRevision.current === revision) setError(String(cause));
    }
  }, []);

  const startNew = useCallback(() => {
    selectionRevision.current += 1;
    setSelectedId(null);
    setNewDraft(true);
    setForm(emptySshProfileForm(newProfileId()));
    setError(null);
  }, []);

  useEffect(() => {
    let active = true;
    void load().catch((cause) => {
      if (active) setError(String(cause));
    });
    return () => {
      active = false;
    };
  }, [load]);

  useEffect(() => {
    if (selectedId && !profiles.some((profile) => profile.id === selectedId)) {
      startNew();
    }
  }, [profiles, selectedId, startNew]);

  const persistSecrets = async (profile: SshProfile, value: SshProfileForm) => {
    await applyCredentialMutation(
      credentialMutation({
        value: value.secret,
        dirty: value.secretDirty,
        remember: value.rememberSecret,
        applicable: profile.authMethod !== "agent",
      }),
      (secret) => remoteNative.setSecret(profile.id, secret),
      () => remoteNative.deleteAuthSecret(profile.id),
    );
    await applyCredentialMutation(
      credentialMutation({
        value: value.proxySecret,
        dirty: value.proxySecretDirty,
        remember: value.rememberProxySecret,
        applicable: Boolean(profile.proxyUrl),
      }),
      (secret) => remoteNative.setProxySecret(profile.id, secret),
      () => remoteNative.deleteProxySecret(profile.id),
    );
  };

  const profileFromValidForm = (value: SshProfileForm) => {
    const issue = profileValidationIssue(value);
    if (issue) {
      setError(t(`remote.validation.${issue}`));
      return null;
    }
    const profile = sshProfileFromForm(value);
    return {
      ...profile,
      tunnels:
        profiles.find((item) => item.id === profile.id)?.tunnels ?? [],
    };
  };

  const persistProfile = async (profile: SshProfile, value: SshProfileForm) => {
    await saveProfile(profile);
    await persistSecrets(profile, value);
    setSelectedId(profile.id);
    setNewDraft(false);
    setForm((current) =>
      current.id === value.id
        ? {
            ...current,
            name: current.name === value.name ? profile.name : current.name,
            secretDirty:
              current.secret === value.secret ? false : current.secretDirty,
            proxySecretDirty:
              current.proxySecret === value.proxySecret
                ? false
                : current.proxySecretDirty,
          }
        : current,
    );
    toast.success(t("remote.actions.saved"));
  };

  const save = async () => {
    const value = form;
    const profile = profileFromValidForm(value);
    if (!profile) return;
    setBusy(true);
    setError(null);
    try {
      await persistProfile(profile, value);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const openWorkspace = async () => {
    const value = form;
    const issue = launchSecretIssue(value);
    if (issue) {
      setError(t(`remote.launch.${issue}`));
      return;
    }
    const profile = profileFromValidForm(value);
    if (!profile) return;
    setBusy(true);
    setError(null);
    try {
      await persistProfile(profile, value);
      await spawnWorkspaceProcess(
        { kind: "ssh", profileId: profile.id },
        "recent",
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const importProfiles = async () => {
    setBusy(true);
    setError(null);
    try {
      const imported = await remoteNative.importConfig();
      const existing = new Set(
        profiles.map(
          (profile) => `${profile.username}@${profile.host}:${profile.port}`,
        ),
      );
      const additions = imported
        .filter(
          (host) => !existing.has(`${host.user}@${host.hostname}:${host.port}`),
        )
        .map(
          (host): SshProfile => ({
            id: newProfileId(),
            name: host.alias,
            host: host.hostname,
            port: host.port,
            username: host.user,
            authMethod: host.identityFile ? "private_key" : "agent",
            identityFile: host.identityFile || null,
            proxyUrl: null,
            keepaliveSeconds: 30,
            reconnectEnabled: true,
            reconnectMaxAttempts: 5,
            rootPath: null,
            tunnels: [],
          }),
        );
      await saveProfiles(additions);
      toast.success(
        additions.length
          ? t("remote.actions.imported", { count: additions.length })
          : t("remote.actions.noImports"),
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (
      !selected ||
      !window.confirm(t("remote.delete.confirm", { name: selected.name }))
    ) {
      return;
    }
    setBusy(true);
    try {
      await deleteProfile(selected.id);
      startNew();
      toast.success(t("remote.actions.deleted"));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const update = <K extends keyof SshProfileForm>(
    key: K,
    value: SshProfileForm[K],
  ) => setForm((current) => ({ ...current, [key]: value }));

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <SectionHeader
        title={t("remote.header.title")}
        description={t("remote.header.description")}
      />

      <div className="grid min-w-0 gap-5 md:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col rounded-xl border border-border/60 bg-card/60">
          <div className="flex gap-2 border-b border-border/60 p-2.5">
            <Button
              size="sm"
              className="min-w-0 flex-1"
              disabled={busy}
              onClick={startNew}
            >
              <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={2} />
              {t("remote.actions.new")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void importProfiles()}
              title={t("remote.actions.import")}
              aria-label={t("remote.actions.import")}
            >
              <HugeiconsIcon icon={Download01Icon} size={13} strokeWidth={2} />
            </Button>
          </div>
          <div className="max-h-[calc(100vh-13rem)] min-h-28 overflow-y-auto p-1.5">
            {profiles.length === 0 ? (
              <p className="px-2 py-4 text-[11px] text-muted-foreground">
                {t("remote.list.empty")}
              </p>
            ) : (
              profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void selectProfile(profile)}
                  className={cn(
                    "mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-accent",
                    selectedId === profile.id && "bg-accent",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-medium">
                      {profile.name}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {profile.username}@{profile.host}:{profile.port}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        <section
          className="min-w-0 rounded-xl border border-border/60 bg-card/60 p-4"
          aria-busy={busy}
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[13px] font-medium">
                {newDraft ? t("remote.editor.new") : t("remote.editor.edit")}
              </h2>
              <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                {t("remote.editor.description")}
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("remote.fields.name")} className="sm:col-span-2">
              <Input
                value={form.name}
                onChange={(event) => update("name", event.target.value)}
                placeholder={t("remote.placeholders.name")}
              />
            </Field>
            <Field label={t("remote.fields.host")}>
              <Input
                value={form.host}
                onChange={(event) => update("host", event.target.value)}
                placeholder={t("remote.placeholders.host")}
                spellCheck={false}
              />
            </Field>
            <Field label={t("remote.fields.port")}>
              <Input
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(event) => update("port", event.target.value)}
              />
            </Field>
            <Field label={t("remote.fields.username")}>
              <Input
                value={form.username}
                onChange={(event) => update("username", event.target.value)}
                autoComplete="username"
              />
            </Field>
            <Field label={t("remote.fields.authentication")}>
              <select
                value={form.authMethod}
                onChange={(event) =>
                  update(
                    "authMethod",
                    event.target.value as SshProfile["authMethod"],
                  )
                }
                className="h-9 rounded-md border bg-background px-3 text-sm"
              >
                <option value="password">{t("remote.auth.password")}</option>
                <option value="private_key">
                  {t("remote.auth.privateKey")}
                </option>
                <option value="agent">{t("remote.auth.agent")}</option>
              </select>
            </Field>
            {form.authMethod === "private_key" ? (
              <Field
                label={t("remote.fields.identityFile")}
                className="sm:col-span-2"
              >
                <Input
                  value={form.identityFile}
                  onChange={(event) =>
                    update("identityFile", event.target.value)
                  }
                  placeholder="~/.ssh/id_ed25519"
                  spellCheck={false}
                />
              </Field>
            ) : null}
            {form.authMethod !== "agent" ? (
              <Field
                label={
                  form.authMethod === "password"
                    ? t("remote.fields.password")
                    : t("remote.fields.passphrase")
                }
                className="sm:col-span-2"
              >
                <Input
                  type="password"
                  value={form.secret}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      secret: event.target.value,
                      secretDirty: true,
                    }))
                  }
                  autoComplete="off"
                />
                <SecretToggle
                  id={`ssh-secret-${form.id}`}
                  checked={form.rememberSecret}
                  onCheckedChange={(value) => update("rememberSecret", value)}
                  label={t("remote.secret.remember")}
                />
              </Field>
            ) : null}
          </div>

          <details className="mt-4 rounded-lg border border-border/60">
            <summary className="cursor-pointer px-3 py-2 text-[11.5px] font-medium text-muted-foreground">
              {t("remote.advanced.title")}
            </summary>
            <div className="grid gap-3 border-t border-border/60 p-3 sm:grid-cols-2">
              <Field label={t("remote.fields.rootPath")}>
                <Input
                  value={form.rootPath}
                  onChange={(event) => update("rootPath", event.target.value)}
                  placeholder="~"
                  spellCheck={false}
                />
              </Field>
              <Field label={t("remote.fields.keepalive")}>
                <Input
                  type="number"
                  min={0}
                  value={form.keepaliveSeconds}
                  onChange={(event) =>
                    update("keepaliveSeconds", event.target.value)
                  }
                />
              </Field>
              <Field
                label={t("remote.fields.proxyUrl")}
                className="sm:col-span-2"
              >
                <Input
                  value={form.proxyUrl}
                  onChange={(event) => update("proxyUrl", event.target.value)}
                  placeholder="socks5://user@127.0.0.1:1080"
                  spellCheck={false}
                />
              </Field>
              {form.proxyUrl.trim() ? (
                <Field
                  label={t("remote.fields.proxyPassword")}
                  className="sm:col-span-2"
                >
                  <Input
                    type="password"
                    value={form.proxySecret}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        proxySecret: event.target.value,
                        proxySecretDirty: true,
                      }))
                    }
                    autoComplete="off"
                  />
                  <SecretToggle
                    id={`ssh-proxy-secret-${form.id}`}
                    checked={form.rememberProxySecret}
                    onCheckedChange={(value) =>
                      update("rememberProxySecret", value)
                    }
                    label={t("remote.secret.rememberProxy")}
                  />
                </Field>
              ) : null}
              <div className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-2 sm:col-span-2">
                <Checkbox
                  id={`ssh-reconnect-${form.id}`}
                  checked={form.reconnectEnabled}
                  onCheckedChange={(value) =>
                    update("reconnectEnabled", value === true)
                  }
                />
                <Label
                  htmlFor={`ssh-reconnect-${form.id}`}
                  className="flex-1 text-[11.5px] font-normal"
                >
                  {t("remote.fields.reconnect")}
                </Label>
                <Label className="text-[10.5px] text-muted-foreground">
                  {t("remote.fields.reconnectAttempts")}
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  className="h-8 w-20"
                  disabled={!form.reconnectEnabled}
                  value={form.reconnectMaxAttempts}
                  onChange={(event) =>
                    update("reconnectMaxAttempts", event.target.value)
                  }
                />
              </div>
            </div>
          </details>

          {error ? (
            <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
              {error}
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
            {selected ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => void remove()}
              >
                {t("remote.actions.delete")}
              </Button>
            ) : null}
            <div className="flex-1" />
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void openWorkspace()}
            >
              {t("remote.actions.openWorkspace")}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              <HugeiconsIcon icon={FloppyDiskIcon} size={13} strokeWidth={2} />
              {t("common.save")}
            </Button>
          </div>
        </section>
      </div>
    </div>
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
      <span className="text-[10.5px] font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

function SecretToggle({
  id,
  checked,
  onCheckedChange,
  label,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <Label
        htmlFor={id}
        className="text-[10.5px] font-normal text-muted-foreground"
      >
        {label}
      </Label>
    </div>
  );
}
/**
 * 本文件提供 SSH profile 的创建、编辑、导入与凭据保存界面。
 * 隧道配置由主 SSH Workspace 管理，编辑 profile 时保留其已保存的隧道。
 */

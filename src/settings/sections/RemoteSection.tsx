/**
 * 本文件提供 SSH 配置与分组的创建、编辑、导入和凭据保存界面。
 * 分组只用于管理和导航；隧道仍由主 SSH Workspace 管理并随配置保存。
 */

import { FormField } from "@/components/layout/FormField";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/controls/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/controls/alert-dialog";
import { Button } from "@/components/controls/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/controls/dialog";
import { Input } from "@/components/controls/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { remoteNative, useRemoteStore } from "@/modules/remote";
import {
  DEFAULT_SSH_GROUP_ID,
  groupNameIssue,
  groupSshProfiles,
} from "@/modules/remote/groups";
import {
  applyCredentialMutation,
  credentialMutation,
  emptySshProfileForm,
  launchSecretIssue,
  profileValidationIssue,
  type SshProfileForm,
  sshProfileFormFrom,
  sshProfileFromForm,
} from "@/modules/remote/profileForm";
import { newGroupId, newProfileId } from "@/modules/remote/store";
import type { SshProfile } from "@/modules/remote/types";
import { spawnWorkspaceProcess } from "@/modules/workspace-process";
import {
  Add01Icon,
  ArrowDown01Icon,
  Delete02Icon,
  Download01Icon,
  Edit02Icon,
  FloppyDiskIcon,
  FolderAddIcon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ConnectionSettingsLayout,
  ConnectionSettingsList,
  ConnectionSettingsItem,
  ConnectionSettingsDetail,
  ConnectionSettingsActions,
} from "@/settings/components/ConnectionSettingsLayout";
import { PageHeader } from "@/components/layout/PageHeader";

const NUMBER_INPUT_CLASS =
  "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

/** 标记配置主体已经保存、但系统钥匙串操作失败的部分成功状态。 */
class CredentialPersistenceError extends Error {
  constructor(cause: unknown) {
    super(String(cause));
    this.name = "CredentialPersistenceError";
  }
}

function blurNumberInputOnWheel(event: React.WheelEvent<HTMLInputElement>) {
  event.currentTarget.blur();
}

/** 管理 SSH 配置、分组、凭据和 Workspace 启动，复用连接设置布局；保存不主动断开现有连接。 */
export function RemoteSection() {
  const { t } = useTranslation("settings");
  const profiles = useRemoteStore((state) => state.profiles);
  const groups = useRemoteStore((state) => state.groups);
  const load = useRemoteStore((state) => state.load);
  const saveProfile = useRemoteStore((state) => state.saveProfile);
  const saveGroup = useRemoteStore((state) => state.saveGroup);
  const deleteGroup = useRemoteStore((state) => state.deleteGroup);
  const saveProfiles = useRemoteStore((state) => state.saveProfiles);
  const deleteProfile = useRemoteStore((state) => state.deleteProfile);
  const [form, setForm] = useState<SshProfileForm>(() =>
    emptySshProfileForm(newProfileId()),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newDraft, setNewDraft] = useState(true);
  const [busy, setBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const [groupEditor, setGroupEditor] = useState<{
    id: string | null;
    name: string;
  } | null>(null);
  const [groupDeleteTarget, setGroupDeleteTarget] = useState<{
    id: string;
    name: string;
    count: number;
  } | null>(null);
  const [groupEditorError, setGroupEditorError] = useState<string | null>(null);
  const selectionRevision = useRef(0);

  const selected = useMemo(
    () => profiles.find((profile) => profile.id === selectedId) ?? null,
    [profiles, selectedId],
  );
  const groupedProfiles = useMemo(
    () => groupSshProfiles(groups, profiles),
    [groups, profiles],
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
        profile.proxyMode === "custom"
          ? remoteNative.getProxySecret(profile.id)
          : null,
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

  const startNew = useCallback((groupId = DEFAULT_SSH_GROUP_ID) => {
    selectionRevision.current += 1;
    setSelectedId(null);
    setNewDraft(true);
    setForm({ ...emptySshProfileForm(newProfileId()), groupId });
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

  useEffect(() => {
    if (
      form.groupId !== DEFAULT_SSH_GROUP_ID &&
      !groups.some((group) => group.id === form.groupId)
    ) {
      setForm((current) => ({
        ...current,
        groupId: DEFAULT_SSH_GROUP_ID,
      }));
    }
  }, [form.groupId, groups]);

  /** 按表单中的记住选项更新系统钥匙串，不把秘密写入共享配置。 */
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
        applicable: profile.proxyMode === "custom",
      }),
      (secret) => remoteNative.setProxySecret(profile.id, secret),
      () => remoteNative.deleteProxySecret(profile.id),
    );
  };

  /** 校验表单并生成可持久化的 SSH 配置，同时保留独立管理的隧道。 */
  const profileFromValidForm = (value: SshProfileForm) => {
    const issue = profileValidationIssue(value);
    if (issue) {
      setError(t(`remote.validation.${issue}`));
      return null;
    }
    const profile = sshProfileFromForm(value);
    return {
      ...profile,
      tunnels: profiles.find((item) => item.id === profile.id)?.tunnels ?? [],
    };
  };

  /** 保存 SSH 配置及用户要求记住的凭据，不在底层持久化函数中触发 UI 提示。 */
  const persistProfile = async (profile: SshProfile, value: SshProfileForm) => {
    await saveProfile(profile);
    try {
      await persistSecrets(profile, value);
    } catch (cause) {
      // 共享配置与系统钥匙串无法组成原子事务，保留准确的部分成功语义。
      throw new CredentialPersistenceError(cause);
    }
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
  };

  /** 将持久化错误转换为能区分配置与钥匙串状态的用户提示。 */
  const persistenceErrorMessage = (cause: unknown) =>
    cause instanceof CredentialPersistenceError
      ? t("remote.persistence.credentialsFailed", { error: cause.message })
      : String(cause);

  /** 显式保存当前 SSH 配置，并只在全部持久化步骤成功后提示已保存。 */
  const save = async () => {
    const value = form;
    const profile = profileFromValidForm(value);
    if (!profile) return;
    setBusy(true);
    setError(null);
    try {
      await persistProfile(profile, value);
      toast.success(t("remote.actions.saved"));
    } catch (cause) {
      setError(persistenceErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  /** 静默保存当前配置后启动远程 Workspace，并准确报告启动阶段的部分失败。 */
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
    // 配置和请求记住的凭据都完成后，后续错误才属于 Workspace 启动阶段。
    let persisted = false;
    try {
      await persistProfile(profile, value);
      persisted = true;
      await spawnWorkspaceProcess(
        { kind: "ssh", profileId: profile.id },
        "recent",
      );
    } catch (cause) {
      setError(
        persisted
          ? t("remote.launch.openFailedAfterSave", { error: String(cause) })
          : persistenceErrorMessage(cause),
      );
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
            groupId: DEFAULT_SSH_GROUP_ID,
            name: host.alias,
            host: host.hostname,
            port: host.port,
            username: host.user,
            authMethod: host.identityFile ? "private_key" : "agent",
            identityFile: host.identityFile || null,
            proxyUrl: null,
            proxyMode: "direct",
            reconnectEnabled: true,
            reconnectMaxAttempts: 2,
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

  const submitGroup = async () => {
    if (!groupEditor) return;
    const issue = groupNameIssue(
      groupEditor.name,
      groups,
      groupEditor.id ?? undefined,
    );
    if (issue) {
      setGroupEditorError(t(`remote.groups.validation.${issue}`));
      return;
    }
    const id = groupEditor.id ?? newGroupId();
    setBusy(true);
    setGroupEditorError(null);
    try {
      await saveGroup({ id, name: groupEditor.name });
      setCollapsedGroups((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      if (!groupEditor.id && newDraft) {
        setForm((current) => ({ ...current, groupId: id }));
      }
      setGroupEditor(null);
      toast.success(
        t(
          groupEditor.id
            ? "remote.groups.actions.renamed"
            : "remote.groups.actions.created",
        ),
      );
    } catch (cause) {
      setGroupEditorError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  /** 打开分组删除确认框，不在用户确认前修改远程配置。 */
  const removeGroup = (groupId: string, name: string) => {
    const count = profiles.filter(
      (profile) => profile.groupId === groupId,
    ).length;
    setGroupDeleteTarget({ id: groupId, name, count });
  };

  /** 删除已确认的分组，并将当前编辑表单回落到默认分组。 */
  const confirmRemoveGroup = async () => {
    if (!groupDeleteTarget) return;
    const { id: groupId } = groupDeleteTarget;
    setGroupDeleteTarget(null);
    setBusy(true);
    setError(null);
    try {
      await deleteGroup(groupId);
      setForm((current) =>
        current.groupId === groupId
          ? { ...current, groupId: DEFAULT_SSH_GROUP_ID }
          : current,
      );
      toast.success(t("remote.groups.actions.deleted"));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  /** 切换 SSH 分组的展开状态，由可折叠内容组件负责平滑过渡。 */
  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
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
    <div className="flex min-w-0 flex-col gap-section">
      <PageHeader
        title={t("remote.header.title")}
        description={t("remote.header.description")}
      />

      <ConnectionSettingsLayout>
        <ConnectionSettingsList
          toolbar={
            <>
              <Button
                className="min-w-0 flex-1"
                disabled={busy}
                onClick={() => startNew()}
              >
                <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={2} />
                {t("remote.actions.new")}
              </Button>
              <Button
                size="icon-sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setGroupEditor({ id: null, name: "" });
                  setGroupEditorError(null);
                }}
                title={t("remote.groups.actions.new")}
                aria-label={t("remote.groups.actions.new")}
              >
                <HugeiconsIcon icon={FolderAddIcon} size={13} strokeWidth={2} />
              </Button>
              <Button
                size="icon-sm"
                variant="outline"
                disabled={busy}
                onClick={() => void importProfiles()}
                title={t("remote.actions.import")}
                aria-label={t("remote.actions.import")}
              >
                <HugeiconsIcon
                  icon={Download01Icon}
                  size={13}
                  strokeWidth={2}
                />
              </Button>
            </>
          }
        >
          {groupedProfiles.map((group) => {
            const collapsed = collapsedGroups.has(group.id);
            const name = group.name ?? t("remote.groups.defaultName");
            return (
              <div key={group.id} data-ssh-group-id={group.id}>
                <div className="mb-0.5 flex min-w-0 items-center gap-0.5">
                  <button
                    type="button"
                    className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] font-medium transition-colors duration-control ease-standard hover:bg-accent"
                    aria-expanded={!collapsed}
                    onClick={() => toggleGroup(group.id)}
                  >
                    <HugeiconsIcon
                      icon={ArrowDown01Icon}
                      size={11}
                      strokeWidth={2}
                      className={cn(
                        "shrink-0 text-muted-foreground transition-transform duration-control ease-standard",
                        collapsed && "-rotate-90",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    <span className="shrink-0 text-[11px] font-normal text-muted-foreground">
                      {group.profiles.length}
                    </span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        disabled={busy}
                        title={t("remote.groups.actions.menu", { name })}
                        aria-label={t("remote.groups.actions.menu", {
                          name,
                        })}
                      >
                        <HugeiconsIcon
                          icon={MoreHorizontalIcon}
                          size={12}
                          strokeWidth={2}
                        />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="min-w-44 p-1">
                      <DropdownMenuItem
                        className="text-[12px]"
                        onSelect={() => startNew(group.id)}
                      >
                        <HugeiconsIcon
                          icon={Add01Icon}
                          size={13}
                          strokeWidth={2}
                        />
                        {t("remote.groups.actions.newProfile")}
                      </DropdownMenuItem>
                      {group.id !== DEFAULT_SSH_GROUP_ID ? (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-[12px]"
                            onSelect={() => {
                              setGroupEditor({
                                id: group.id,
                                name: group.name ?? "",
                              });
                              setGroupEditorError(null);
                            }}
                          >
                            <HugeiconsIcon
                              icon={Edit02Icon}
                              size={13}
                              strokeWidth={2}
                            />
                            {t("remote.groups.actions.rename")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            className="text-[12px]"
                            onSelect={() => removeGroup(group.id, name)}
                          >
                            <HugeiconsIcon
                              icon={Delete02Icon}
                              size={13}
                              strokeWidth={2}
                            />
                            {t("remote.groups.actions.delete")}
                          </DropdownMenuItem>
                        </>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <Collapsible open={!collapsed}>
                  <CollapsibleContent className="terax-collapsible-content">
                    <div>
                      {group.profiles.map((profile) => (
                        <ConnectionSettingsItem
                          key={profile.id}
                          selected={selectedId === profile.id}
                          type="button"
                          disabled={busy}
                          onClick={() => void selectProfile(profile)}
                          className="ml-5 w-[calc(100%-1.25rem)]"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-[13px] font-medium">
                              {profile.name}
                            </span>
                            <span className="block truncate font-mono text-[11px] text-muted-foreground">
                              {profile.username}@{profile.host}:{profile.port}
                            </span>
                          </span>
                        </ConnectionSettingsItem>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            );
          })}
          {profiles.length === 0 ? (
            <p className="px-2 py-4 text-[11px] text-muted-foreground">
              {t("remote.list.empty")}
            </p>
          ) : null}
        </ConnectionSettingsList>

        <ConnectionSettingsDetail selectionKey={form.id} aria-busy={busy}>
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[13px] font-medium">
                {newDraft ? t("remote.editor.new") : t("remote.editor.edit")}
              </h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {t("remote.editor.description")}
              </p>
            </div>
          </div>

          <div className="grid items-start gap-3 sm:grid-cols-2">
            <FormField label={t("remote.fields.name")}>
              <Input
                value={form.name}
                onChange={(event) => update("name", event.target.value)}
                placeholder={t("remote.placeholders.name")}
              />
              <p className="text-[11px] text-muted-foreground">
                {t("remote.hints.name")}
              </p>
            </FormField>
            <FormField label={t("remote.fields.group")}>
              <Select
                value={form.groupId}
                onValueChange={(value) => update("groupId", value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  align="start"
                  className="[&_[data-position=popper]]:h-auto"
                >
                  <SelectItem value={DEFAULT_SSH_GROUP_ID}>
                    {t("remote.groups.defaultName")}
                  </SelectItem>
                  {groups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label={t("remote.fields.host")}>
              <Input
                value={form.host}
                onChange={(event) => update("host", event.target.value)}
                placeholder={t("remote.placeholders.host")}
                spellCheck={false}
              />
            </FormField>
            <FormField label={t("remote.fields.port")}>
              <Input
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(event) => update("port", event.target.value)}
                className={NUMBER_INPUT_CLASS}
                onWheel={blurNumberInputOnWheel}
              />
            </FormField>
            <FormField label={t("remote.fields.username")}>
              <Input
                value={form.username}
                onChange={(event) => update("username", event.target.value)}
                autoComplete="username"
              />
            </FormField>
            <FormField label={t("remote.fields.authentication")}>
              <Select
                value={form.authMethod}
                onValueChange={(value) =>
                  update("authMethod", value as SshProfile["authMethod"])
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  align="start"
                  className="[&_[data-position=popper]]:h-auto"
                >
                  <SelectItem value="password">
                    {t("remote.auth.password")}
                  </SelectItem>
                  <SelectItem value="private_key">
                    {t("remote.auth.privateKey")}
                  </SelectItem>
                  <SelectItem value="agent">
                    {t("remote.auth.agent")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </FormField>
            {form.authMethod === "private_key" ? (
              <FormField
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
              </FormField>
            ) : null}
            {form.authMethod !== "agent" ? (
              <FormField
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
              </FormField>
            ) : null}
          </div>

          <Collapsible
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            className="mt-4 border-t border-border/60"
          >
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-between px-3 py-2 text-left text-[12px] font-medium text-muted-foreground transition-colors duration-control ease-standard hover:bg-interactive-hover"
              >
                {t("remote.advanced.title")}
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={12}
                  strokeWidth={2}
                  className={cn(
                    "transition-transform duration-control ease-standard",
                    !advancedOpen && "-rotate-90",
                  )}
                />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="terax-collapsible-content">
              <div className="grid gap-3 p-3 sm:grid-cols-2">
                <FormField label={t("remote.fields.rootPath")}>
                  <Input
                    value={form.rootPath}
                    onChange={(event) => update("rootPath", event.target.value)}
                    placeholder="~"
                    spellCheck={false}
                  />
                </FormField>
                <FormField
                  label={t("settings:network.route")}
                  className="sm:col-span-2"
                >
                  <Select
                    value={form.proxyMode}
                    onValueChange={(value) => {
                      if (
                        value === "direct" ||
                        value === "shared" ||
                        value === "custom"
                      )
                        update("proxyMode", value);
                    }}
                  >
                    <SelectTrigger aria-label={t("settings:network.route")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="direct">
                        {t("settings:network.direct")}
                      </SelectItem>
                      <SelectItem value="shared">
                        {t("settings:network.shared")}
                      </SelectItem>
                      <SelectItem value="custom">
                        {t("settings:network.custom")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t("settings:network.sshHint")}
                  </p>
                </FormField>
                {form.proxyMode === "custom" && (
                  <FormField
                    label={t("remote.fields.proxyUrl")}
                    className="sm:col-span-2"
                  >
                    <Input
                      value={form.proxyUrl}
                      onChange={(event) =>
                        update("proxyUrl", event.target.value)
                      }
                      placeholder={t("remote.placeholders.proxyUrl")}
                      spellCheck={false}
                    />
                  </FormField>
                )}
                {form.proxyMode === "custom" && form.proxyUrl.trim() ? (
                  <FormField
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
                  </FormField>
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
                    className="flex-1 text-[12px] font-normal"
                  >
                    {t("remote.fields.reconnect")}
                  </Label>
                  <Label className="text-[11px] text-muted-foreground">
                    {t("remote.fields.reconnectAttempts")}
                  </Label>
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    className={`h-8 w-20 ${NUMBER_INPUT_CLASS}`}
                    disabled={!form.reconnectEnabled}
                    value={form.reconnectMaxAttempts}
                    onChange={(event) =>
                      update("reconnectMaxAttempts", event.target.value)
                    }
                    onWheel={blurNumberInputOnWheel}
                  />
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {error ? (
            <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
              {error}
            </p>
          ) : null}

          <ConnectionSettingsActions>
            {selected ? (
              <Button
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                disabled={busy}
                onClick={() => void remove()}
              >
                {t("remote.actions.delete")}
              </Button>
            ) : null}
            <div className="flex-1" />
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void openWorkspace()}
            >
              {t("remote.actions.openWorkspace")}
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              <HugeiconsIcon icon={FloppyDiskIcon} size={13} strokeWidth={2} />
              {t("common.save")}
            </Button>
          </ConnectionSettingsActions>
        </ConnectionSettingsDetail>
      </ConnectionSettingsLayout>

      <Dialog
        open={groupEditor !== null}
        onOpenChange={(open) => {
          if (!open) {
            setGroupEditor(null);
            setGroupEditorError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitGroup();
            }}
          >
            <DialogHeader>
              <DialogTitle className="text-sm">
                {t(
                  groupEditor?.id
                    ? "remote.groups.editor.renameTitle"
                    : "remote.groups.editor.newTitle",
                )}
              </DialogTitle>
              <DialogDescription className="text-[11px]">
                {t("remote.groups.editor.description")}
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 grid gap-1.5">
              <Label htmlFor="ssh-group-name" className="text-[11px]">
                {t("remote.groups.editor.name")}
              </Label>
              <Input
                id="ssh-group-name"
                autoFocus
                value={groupEditor?.name ?? ""}
                onChange={(event) => {
                  setGroupEditor((current) =>
                    current
                      ? { ...current, name: event.target.value }
                      : current,
                  );
                  setGroupEditorError(null);
                }}
              />
              {groupEditorError ? (
                <p className="text-[11px] text-destructive">
                  {groupEditorError}
                </p>
              ) : null}
            </div>
            <DialogFooter className="mt-5">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setGroupEditor(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={groupDeleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setGroupDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("remote.groups.actions.delete")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {groupDeleteTarget
                ? t("remote.groups.delete.confirm", groupDeleteTarget)
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmRemoveGroup()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
            >
              {t("remote.groups.actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
        className="text-[11px] font-normal text-muted-foreground"
      >
        {label}
      </Label>
    </div>
  );
}

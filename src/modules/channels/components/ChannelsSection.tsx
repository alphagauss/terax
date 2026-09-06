/**
 * 本文件实现 Channels 双栏管理页、平台选择菜单和实例编辑。
 * 草稿按连接 ID 保留，设置窗口只订阅主窗口并发送管理请求，不拥有连接运行时。
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  type ChannelAction,
  requestChannels,
  subscribeChannelsView,
  useChannelsView,
} from "@/modules/channels/client";
import {
  ChannelConnectionEditor,
  type ChannelDraft,
} from "@/modules/channels/components/ChannelConnectionEditor";
import { ConnectionStatus } from "@/modules/channels/components/ConnectionStatus";
import type { ChannelConnection } from "@/modules/channels/types";
import {
  spawnWorkspaceProcess,
  type WorkspaceBootstrap,
} from "@/modules/workspace-process";
import {
  ConnectionSettingsLayout,
  ConnectionSettingsList,
  ConnectionSettingsItem,
  ConnectionSettingsDetail,
} from "@/settings/components/ConnectionSettingsLayout";
import { SectionHeader } from "@/settings/components/SectionHeader";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const CHANNEL_OPTIONS = [
  { kind: "weixin", labelKey: "weixin", defaultNameKey: "defaultName" },
] satisfies {
  kind: ChannelConnection["kind"];
  labelKey: string;
  defaultNameKey: string;
}[];

/** 管理实例草稿与显式保存；运行说明置于内容区底部，长内容按正常文档流延伸。 */
export function ChannelsSection() {
  const { t } = useTranslation("channels");
  const snapshots = useChannelsView((state) => state.snapshots);
  const serviceError = useChannelsView((state) => state.error);
  const [owner, setOwner] = useState<boolean | null>(null);
  const [ready, setReady] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Partial<ChannelDraft>>>(
    {},
  );
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [loginPendingId, setLoginPendingId] = useState<string | null>(null);
  const pending = useRef(false);
  const selected =
    snapshots.find((item) => item.connection.id === selectedId) ?? snapshots[0];
  const connection = selected?.connection;
  const id = connection?.id;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 重试版本重新建立订阅；卸载只释放监听，不取消主窗口任务。
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    setReady(false);
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
        if (!disposed)
          setErrors((current) => ({ ...current, page: "unavailable" }));
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [retry]);

  /** 同一设置页一次只提交一组操作，错误归属发起实例，切换选择不会串入其他详情。 */
  const perform = async (
    key: string,
    work: () => Promise<void>,
  ): Promise<boolean> => {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      await work();
      return true;
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [key]: error instanceof Error ? error.message : "unavailable",
      }));
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const run = (action: ChannelAction) =>
    perform("id" in action ? action.id : "page", async () => {
      if (action.action === "login") setLoginPendingId(action.id);
      try {
        await requestChannels(action);
      } finally {
        if (action.action === "login") setLoginPendingId(null);
      }
    });

  /** 选定平台后保存默认命名实例并进入授权；只打开或关闭菜单不会创建记录。 */
  const add = async (platform: (typeof CHANNEL_OPTIONS)[number]) => {
    let createdId: string | undefined;
    await perform("page", async () => {
      const names = new Set(snapshots.map((item) => item.connection.name));
      let number = 1;
      while (names.has(t(platform.defaultNameKey, { number }))) number++;
      const existing = new Set(snapshots.map((item) => item.connection.id));
      const view = await requestChannels({
        action: "add",
        kind: platform.kind,
        name: t(platform.defaultNameKey, { number }),
      });
      createdId = view.snapshots.find(
        (item) => !existing.has(item.connection.id),
      )?.connection.id;
      if (!createdId) throw new Error("storage");
      setSelectedId(createdId);
    });
    if (createdId) await run({ action: "login", id: createdId });
  };

  // 以显式实例身份更新或清除草稿，异步保存完成时不依赖当前选择。
  const updateDraft = (targetId: string, patch?: Partial<ChannelDraft>) => {
    setDrafts((current) => {
      const next = { ...current };
      if (patch) next[targetId] = { ...next[targetId], ...patch };
      else delete next[targetId];
      return next;
    });
  };

  const message = errors.page ?? serviceError;
  const disabled = busy || !ready || Boolean(serviceError);
  const groups = new Map<string, typeof snapshots>();
  for (const snapshot of snapshots) {
    const group = groups.get(snapshot.connection.kind);
    if (group) group.push(snapshot);
    else groups.set(snapshot.connection.kind, [snapshot]);
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-5">
      <SectionHeader title={t("title")} description={t("description")} />
      {owner === false ? (
        <div className="flex flex-col gap-3 text-[12px] text-muted-foreground">
          <p>{t("localOnly")}</p>
          <Button
            variant="outline"
            className="self-start"
            onClick={() =>
              void perform("page", () =>
                spawnWorkspaceProcess({ kind: "local" }, "recent").then(
                  () => {},
                ),
              )
            }
          >
            {t("openLocal")}
          </Button>
        </div>
      ) : (
        <ConnectionSettingsLayout>
          <ConnectionSettingsList
            toolbar={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    className="w-full text-[12px]"
                    disabled={disabled}
                  >
                    {t("add")}
                    <HugeiconsIcon
                      icon={ArrowDown01Icon}
                      size={12}
                      strokeWidth={2}
                    />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-[var(--radix-dropdown-menu-trigger-width)]"
                >
                  {CHANNEL_OPTIONS.map((platform) => (
                    <DropdownMenuItem
                      key={platform.kind}
                      disabled={disabled}
                      onSelect={() => void add(platform)}
                    >
                      {t(platform.labelKey)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            }
          >
            {[...groups].map(([kind, members]) => (
              <div key={kind} className="mb-2">
                <div className="flex items-center justify-between px-2.5 py-2 text-[12px] font-medium text-muted-foreground">
                  <span>{t(kind)}</span>
                  <span>{members.length}</span>
                </div>
                {members.map((snapshot) => (
                  <ConnectionSettingsItem
                    key={snapshot.connection.id}
                    selected={id === snapshot.connection.id}
                    onClick={() => setSelectedId(snapshot.connection.id)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="truncate text-[13px] font-medium">
                        {snapshot.connection.name}
                      </span>
                      <ConnectionStatus snapshot={snapshot} />
                    </span>
                  </ConnectionSettingsItem>
                ))}
              </div>
            ))}
            {!snapshots.length ? (
              <p className="px-2.5 py-4 text-[12px] text-muted-foreground">
                {t(ready ? "empty" : "loading")}
              </p>
            ) : null}
          </ConnectionSettingsList>
          <ConnectionSettingsDetail
            selectionKey={id ?? "empty"}
            aria-busy={busy}
          >
            {selected ? (
              <ChannelConnectionEditor
                snapshot={selected}
                edits={drafts[selected.connection.id]}
                loginPending={loginPendingId === selected.connection.id}
                disabled={disabled}
                error={errors[selected.connection.id]}
                updateDraft={updateDraft}
                run={run}
                perform={perform}
              />
            ) : (
              <p className="py-8 text-center text-[12px] text-muted-foreground">
                {t(ready ? "emptyDetail" : "loading")}
              </p>
            )}
          </ConnectionSettingsDetail>
        </ConnectionSettingsLayout>
      )}
      {message ? (
        <div className="flex items-center gap-3">
          <p role="alert" className="text-[12px] text-destructive">
            {t(`errors.${message}`, { defaultValue: t("errors.unavailable") })}
          </p>
          {!ready && owner !== false ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setErrors((current) => ({ ...current, page: undefined }));
                setRetry((value) => value + 1);
              }}
            >
              {t("reconnect")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {owner !== false ? (
        <p className="mt-auto text-[11px] leading-relaxed text-muted-foreground">
          {t("defaults")}
        </p>
      ) : null}
    </div>
  );
}

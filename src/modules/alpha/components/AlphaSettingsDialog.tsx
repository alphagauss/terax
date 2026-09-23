/**
 * 本文件实现三栏工作页的 Alpha 设置对话框，不依赖业务服务已启动。
 * 页面管理服务状态、数据目录和解释器设置，服务控制仍通过 Rust 的幂等命令完成。
 */

import { Button } from "@/components/controls/button";
import { Hint } from "@/components/controls/tooltip";
import { SettingGroup } from "@/components/settings/SettingGroup";
import { SettingRow } from "@/components/settings/SettingRow";
import { Switch } from "@/components/ui/switch";
import { getAlphaSettings, updateAlphaSettings } from "@/modules/alpha/api";
import {
  type AlphaStatus,
  checkAlphaPython,
  type PythonCheck,
  restartAlpha,
  setAlphaAutoStart,
  setAlphaPythonPath,
  startAlpha,
  stopAlpha,
} from "@/modules/alpha/native";
import {
  setAlphaShowInRemote,
  useAlphaShowInRemote,
} from "@/modules/alpha/preferences";
import {
  AlphaQueryProvider,
  alphaQueryKeys,
  useAlphaServiceStatus,
} from "@/modules/alpha/query";
import {
  type PythonInterpreter,
  PythonInterpreterDialog,
} from "@/modules/python";
import { WorkbenchPageDialog } from "@/modules/workbench/WorkbenchPageOverlays";
import { LOCAL_WORKSPACE } from "@/modules/workspace";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

type Action =
  | "autoStart"
  | "remoteVisibility"
  | "check"
  | "dataDir"
  | "browseDataDir"
  | "start"
  | "stop"
  | "restart"
  | "select"
  | null;

type Props = {
  visible: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** 将 Alpha 服务的 UTC 启动时间转换为当前界面语言的本地时间。 */
function formatStartedAt(value: string, language: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

/** 缩短运行代码哈希，完整 revision 仍通过标题提供。 */
function formatRuntimeRevision(value: string): string {
  const separator = value.indexOf(":");
  if (separator < 0 || value.length <= separator + 13) return value;
  return `${value.slice(0, separator + 1)}${value.slice(separator + 1, separator + 13)}`;
}

/**
 * 渲染共享 Python 解释器配置与 Alpha 服务控制。
 *
 * Workbench 隐藏页面时停止探测，重新显示后立即刷新并恢复定时轮询。
 */
export function AlphaSettingsDialog(props: Props) {
  return (
    <AlphaQueryProvider>
      <AlphaSettingsContent {...props} />
    </AlphaQueryProvider>
  );
}

/** 连接共享状态并渲染 Alpha 服务设置。 */
function AlphaSettingsContent({ visible, open: isOpen, onOpenChange }: Props) {
  const { i18n, t } = useTranslation("alpha");
  const queryClient = useQueryClient();
  const service = useAlphaServiceStatus(visible && isOpen);
  const status = service.data ?? null;
  const settings = useQuery({
    queryKey: alphaQueryKeys.settings,
    queryFn: getAlphaSettings,
    enabled: visible && isOpen && status?.running === true,
  });
  const [check, setCheck] = useState<PythonCheck | null>(null);
  const [dataDirDraft, setDataDirDraft] = useState<string | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [pythonPickerOpen, setPythonPickerOpen] = useState(false);
  const showInRemote = useAlphaShowInRemote();
  const savedDataDir = settings.data?.dataDir ?? null;
  // 未提交目录独立于权威快照，切页刷新和服务重连不能覆盖用户选择。
  const dataDir = dataDirDraft ?? savedDataDir;

  /** 发布生命周期命令结果，并同步暂停或刷新 Alpha 业务查询。 */
  const publishStatus = async (nextStatus: AlphaStatus) => {
    // 丢弃命令完成前发出的探活结果，避免旧状态晚到后覆盖启停结果。
    await queryClient.cancelQueries({
      queryKey: alphaQueryKeys.service,
      exact: true,
    });
    queryClient.setQueryData(alphaQueryKeys.service, nextStatus);
    if (nextStatus.running) {
      await queryClient.invalidateQueries({
        queryKey: alphaQueryKeys.all,
        predicate: (query) => query.queryKey[1] !== alphaQueryKeys.service[1],
      });
    } else {
      await queryClient.cancelQueries({
        queryKey: alphaQueryKeys.all,
        predicate: (query) => query.queryKey[1] !== alphaQueryKeys.service[1],
      });
    }
  };

  const run = async (
    next: "start" | "stop" | "restart",
    operation: () => Promise<AlphaStatus>,
  ) => {
    setAction(next);
    try {
      const nextStatus = await operation();
      await publishStatus(nextStatus);
    } catch (error) {
      toast.error(t(`actions.${next}Failed`), {
        description: String(error),
      });
      await service.refetch();
    } finally {
      setAction(null);
    }
  };

  const selectDataDir = async () => {
    if (action !== null) return;
    setAction("browseDataDir");
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("storage.selectTitle"),
      });
      if (!selected || Array.isArray(selected)) return;
      setDataDirDraft(selected);
    } catch (error) {
      toast.error(t("errors.setting"), {
        description: String(error),
      });
    } finally {
      setAction(null);
    }
  };

  const saveDataDir = async () => {
    if (!dataDir) return;
    setAction("dataDir");
    try {
      const saved = await updateAlphaSettings({ dataDir });
      setDataDirDraft(null);
      queryClient.setQueryData(alphaQueryKeys.settings, saved);
      await publishStatus(await restartAlpha());
    } catch (error) {
      toast.error(t("errors.setting"), {
        description: String(error),
      });
      await service.refetch();
    } finally {
      setAction(null);
    }
  };

  /** 保存发现列表或手动浏览得到的本机解释器。 */
  const selectPython = async (interpreter: PythonInterpreter) => {
    setAction("select");
    try {
      await setAlphaPythonPath(interpreter.path);
      setCheck(null);
      await service.refetch();
    } finally {
      setAction(null);
    }
  };

  const checkPython = async () => {
    setAction("check");
    try {
      setCheck(await checkAlphaPython());
    } catch (error) {
      toast.error(t("errors.python"), {
        description: String(error),
      });
    } finally {
      setAction(null);
    }
  };

  const toggleAutoStart = async (enabled: boolean) => {
    setAction("autoStart");
    try {
      await setAlphaAutoStart(enabled);
      await service.refetch();
    } catch (error) {
      toast.error(t("errors.setting"), {
        description: String(error),
      });
    } finally {
      setAction(null);
    }
  };

  const toggleRemoteVisibility = async (enabled: boolean) => {
    setAction("remoteVisibility");
    try {
      await setAlphaShowInRemote(enabled);
    } catch (error) {
      toast.error(t("errors.setting"), {
        description: String(error),
      });
    } finally {
      setAction(null);
    }
  };

  const statusError = service.error && !service.data;
  const stateText = statusError
    ? t("errors.status")
    : status?.running
      ? t("service.running", { port: status.port })
      : status?.issue === "portConflict"
        ? t("service.portConflict", { port: status.port })
        : status
          ? t("service.stopped")
          : t("service.loading");

  return (
    <WorkbenchPageDialog
      open={isOpen}
      onOpenChange={(next) => {
        if (action === null) onOpenChange(next);
      }}
      title={t("header.title")}
      className="w-[48rem]"
    >
      <div className="flex min-w-0 flex-col gap-section">
        <p className="text-muted-foreground">{t("header.description")}</p>

        <SettingGroup title={t("python.label")}>
          <SettingRow
            title={t("python.title")}
            description={t("python.description")}
          >
            <div className="flex max-w-90 items-center gap-2">
              <Hint content={status?.pythonPath ?? undefined}>
                <span className="max-w-62 truncate text-[11px] text-muted-foreground">
                  {status?.pythonPath ?? t("python.unconfigured")}
                </span>
              </Hint>
              <Button
                variant="outline"
                disabled={action !== null}
                onClick={() => setPythonPickerOpen(true)}
              >
                {t("python.select")}
              </Button>
            </div>
          </SettingRow>
          {status?.configured ? (
            <SettingRow
              title={t("dependencies.title")}
              description={
                check?.error ??
                (check?.missingPackages.length
                  ? t("dependencies.missing", {
                      packages: check.missingPackages.join(", "),
                    })
                  : check?.version
                    ? t("dependencies.ready", { version: check.version })
                    : t("dependencies.description"))
              }
            >
              <Button
                variant="outline"
                disabled={action !== null}
                onClick={() => void checkPython()}
              >
                {action === "check"
                  ? t("dependencies.checking")
                  : t("dependencies.check")}
              </Button>
            </SettingRow>
          ) : null}
        </SettingGroup>

        <SettingGroup title={t("availability.label")}>
          <SettingRow
            title={t("availability.title")}
            description={t("availability.description")}
          >
            <Switch
              checked={showInRemote}
              disabled={action !== null}
              onCheckedChange={(enabled) =>
                void toggleRemoteVisibility(enabled)
              }
            />
          </SettingRow>
        </SettingGroup>

        <SettingGroup title={t("storage.label")}>
          <SettingRow
            title={t("storage.title")}
            description={
              !service.data && service.isPending
                ? t("common.loading")
                : !status?.running
                  ? t("storage.unavailable")
                  : settings.error
                    ? `${t("errors.setting")}: ${String(settings.error)}`
                    : dataDir === null
                      ? t("storage.loading")
                      : t("storage.description")
            }
          >
            <div className="flex max-w-90 items-center gap-2">
              <Hint
                content={status?.running ? (dataDir ?? undefined) : undefined}
              >
                <span className="max-w-54 truncate text-[11px] text-muted-foreground">
                  {!service.data && service.isPending
                    ? t("common.loading")
                    : status?.running
                      ? settings.error
                        ? t("errors.setting")
                        : (dataDir ?? t("storage.loading"))
                      : t("storage.unavailable")}
                </span>
              </Hint>
              <Button
                variant="outline"
                disabled={
                  !status?.running ||
                  (!settings.error && dataDir === null) ||
                  settings.isFetching ||
                  action !== null
                }
                onClick={() => {
                  if (settings.error) {
                    void settings.refetch();
                  } else {
                    void selectDataDir();
                  }
                }}
              >
                {settings.error ? t("common.retry") : t("storage.select")}
              </Button>
              <Button
                disabled={
                  !status?.running ||
                  dataDir === null ||
                  dataDir === savedDataDir ||
                  settings.isFetching ||
                  action !== null
                }
                onClick={() => void saveDataDir()}
              >
                {action === "dataDir" ? t("storage.saving") : t("storage.save")}
              </Button>
            </div>
          </SettingRow>
        </SettingGroup>

        <SettingGroup title={t("service.label")}>
          <SettingRow title={t("service.title")} description={stateText}>
            <span
              className={
                status?.running
                  ? "text-[11px] font-medium text-success"
                  : status
                    ? "text-[11px] font-medium text-destructive"
                    : "text-[11px] font-medium text-muted-foreground"
              }
            >
              {status?.running
                ? t("service.statusRunning")
                : status === null
                  ? t("service.statusUnknown")
                  : t("service.statusStopped")}
            </span>
          </SettingRow>
          {status?.running ? (
            <>
              <SettingRow
                title={t("service.startedAtTitle")}
                description={t("service.startedAtDescription")}
              >
                <span className="text-[11px] text-muted-foreground">
                  {status.startedAt
                    ? formatStartedAt(status.startedAt, i18n.language)
                    : t("service.unknownValue")}
                </span>
              </SettingRow>
              <SettingRow
                title={t("service.runtimeRevisionTitle")}
                description={t("service.runtimeRevisionDescription")}
              >
                <Hint content={status.runtimeRevision ?? undefined}>
                  <span className="max-w-48 truncate font-mono text-[11px] text-muted-foreground">
                    {status.runtimeRevision
                      ? formatRuntimeRevision(status.runtimeRevision)
                      : t("service.unknownValue")}
                  </span>
                </Hint>
              </SettingRow>
            </>
          ) : null}
          <SettingRow
            title={t("autoStart.title")}
            description={t("autoStart.description")}
          >
            <Switch
              checked={status?.autoStart ?? true}
              disabled={status === null || action !== null}
              onCheckedChange={(enabled) => void toggleAutoStart(enabled)}
            />
          </SettingRow>
          <div className="flex flex-wrap justify-end gap-2 px-3 py-2">
            {status?.running ? (
              <>
                <Button
                  variant="outline"
                  disabled={action !== null}
                  onClick={() => void run("restart", restartAlpha)}
                >
                  {action === "restart"
                    ? t("actions.restarting")
                    : t("actions.restart")}
                </Button>
                <Button
                  variant="destructive"
                  disabled={action !== null}
                  onClick={() => void run("stop", stopAlpha)}
                >
                  {action === "stop"
                    ? t("actions.stopping")
                    : t("actions.stop")}
                </Button>
              </>
            ) : (
              <Button
                disabled={action !== null || !status?.configured}
                onClick={() => void run("start", startAlpha)}
              >
                {action === "start"
                  ? t("actions.starting")
                  : t("actions.start")}
              </Button>
            )}
          </div>
        </SettingGroup>
      </div>
      <PythonInterpreterDialog
        scope="page"
        open={pythonPickerOpen}
        onOpenChange={setPythonPickerOpen}
        root={null}
        workspace={LOCAL_WORKSPACE}
        selectedPath={status?.pythonPath}
        title={t("python.selectTitle")}
        onSelect={selectPython}
      />
    </WorkbenchPageDialog>
  );
}

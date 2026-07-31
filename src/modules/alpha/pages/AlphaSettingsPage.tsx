/**
 * 本文件实现 Alpha 的 Workbench 设置页。
 * 页面管理服务状态、数据目录和解释器设置，服务控制仍通过 Rust 的幂等命令完成。
 */

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  getAlphaSettings,
  updateAlphaSettings,
} from "@/modules/alpha/api";
import {
  type AlphaStatus,
  checkAlphaPython,
  getAlphaStatus,
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
import { SectionHeader } from "@/settings/components/SectionHeader";
import { SettingRow } from "@/settings/components/SettingRow";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

type Action =
  | "autoStart"
  | "remoteVisibility"
  | "check"
  | "dataDir"
  | "start"
  | "stop"
  | "restart"
  | "select"
  | null;

type Props = {
  visible: boolean;
};

/**
 * 渲染共享 Python 解释器配置与 Alpha 服务控制。
 *
 * Workbench 隐藏页面时停止探测，重新显示后立即刷新并恢复定时轮询。
 */
export function AlphaSettingsPage({ visible }: Props) {
  const { t } = useTranslation("alpha");
  const [status, setStatus] = useState<AlphaStatus | null>(null);
  const [check, setCheck] = useState<PythonCheck | null>(null);
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [savedDataDir, setSavedDataDir] = useState<string | null>(null);
  const [action, setAction] = useState<Action>(null);
  const showInRemote = useAlphaShowInRemote();

  const refresh = useCallback(
    async (notifyOnError = false) => {
      try {
        setStatus(await getAlphaStatus());
      } catch (error) {
        if (notifyOnError) {
          toast.error(t("errors.status"), {
            description: String(error),
          });
        }
      }
    },
    [t],
  );

  const refreshSettings = useCallback(async () => {
    try {
      const settings = await getAlphaSettings();
      setDataDir(settings.dataDir);
      setSavedDataDir(settings.dataDir);
    } catch {
      setDataDir(null);
      setSavedDataDir(null);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void refresh(true);
    void refreshSettings();
    const timer = window.setInterval(() => void refresh(), 2500);
    const refreshOnFocus = () => void refresh();
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [refresh, refreshSettings, visible]);

  const run = async (
    next: "start" | "stop" | "restart",
    operation: () => Promise<AlphaStatus>,
  ) => {
    setAction(next);
    try {
      const nextStatus = await operation();
      setStatus(nextStatus);
      if (nextStatus.running) {
        await refreshSettings();
      }
    } catch (error) {
      toast.error(t(`actions.${next}Failed`), {
        description: String(error),
      });
      await refresh();
    } finally {
      setAction(null);
    }
  };

  const selectDataDir = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("storage.selectTitle"),
      });
      if (!selected || Array.isArray(selected)) return;
      setDataDir(selected);
    } catch (error) {
      toast.error(t("errors.setting"), {
        description: String(error),
      });
    }
  };

  const saveDataDir = async () => {
    if (!dataDir) return;
    setAction("dataDir");
    try {
      const saved = await updateAlphaSettings({ dataDir });
      setDataDir(saved.dataDir);
      setSavedDataDir(saved.dataDir);
      setStatus(await restartAlpha());
    } catch (error) {
      toast.error(t("errors.setting"), {
        description: String(error),
      });
      await refresh();
    } finally {
      setAction(null);
    }
  };

  const selectPython = async () => {
    setAction("select");
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        title: t("python.selectTitle"),
      });
      if (!selected || Array.isArray(selected)) return;
      await setAlphaPythonPath(selected);
      setCheck(null);
      await refresh();
    } catch (error) {
      toast.error(t("errors.python"), {
        description: String(error),
      });
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
      await refresh();
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

  const stateText = status?.running
    ? t("service.running", { port: status.port })
    : status?.issue === "portConflict"
      ? t("service.portConflict", { port: status.port })
      : status
        ? t("service.stopped")
        : t("service.loading");

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-8 py-6">
        <SectionHeader
          title={t("header.title")}
          description={t("header.description")}
        />

        <div className="flex flex-col gap-2">
          <Label>{t("python.label")}</Label>
          <SettingRow
            title={t("python.title")}
            description={t("python.description")}
            className="items-center"
          >
            <div className="flex max-w-90 items-center gap-2">
              <span
                className="max-w-62 truncate text-[11px] text-muted-foreground"
                title={status?.pythonPath ?? undefined}
              >
                {status?.pythonPath ?? t("python.unconfigured")}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={action !== null}
                onClick={() => void selectPython()}
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
                size="sm"
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
        </div>

        <div className="flex flex-col gap-2">
          <Label>{t("availability.label")}</Label>
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
        </div>

        <div className="flex flex-col gap-2">
          <Label>{t("storage.label")}</Label>
          <SettingRow
            title={t("storage.title")}
            description={
              dataDir === null
                ? t("storage.unavailable")
                : t("storage.description")
            }
            className="items-center"
          >
            <div className="flex max-w-90 items-center gap-2">
              <span
                className="max-w-54 truncate text-[11px] text-muted-foreground"
                title={dataDir ?? undefined}
              >
                {dataDir ?? t("storage.loading")}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={dataDir === null || action !== null}
                onClick={() => void selectDataDir()}
              >
                {t("storage.select")}
              </Button>
              <Button
                size="sm"
                disabled={
                  dataDir === null || dataDir === savedDataDir || action !== null
                }
                onClick={() => void saveDataDir()}
              >
                {action === "dataDir"
                  ? t("storage.saving")
                  : t("storage.save")}
              </Button>
            </div>
          </SettingRow>
        </div>

        <div className="flex flex-col gap-2">
          <Label>{t("service.label")}</Label>
          <SettingRow title={t("service.title")} description={stateText}>
            <span
              className={
                status?.running
                  ? "text-[11px] font-medium text-emerald-500"
                  : "text-[11px] font-medium text-muted-foreground"
              }
            >
              {status?.running
                ? t("service.statusRunning")
                : t("service.statusStopped")}
            </span>
          </SettingRow>
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
          <div className="flex justify-end gap-2 pt-1">
            {status?.running ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={action !== null}
                  onClick={() => void run("restart", restartAlpha)}
                >
                  {action === "restart"
                    ? t("actions.restarting")
                    : t("actions.restart")}
                </Button>
                <Button
                  size="sm"
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
                size="sm"
                disabled={action !== null || !status?.configured}
                onClick={() => void run("start", startAlpha)}
              >
                {action === "start"
                  ? t("actions.starting")
                  : t("actions.start")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}

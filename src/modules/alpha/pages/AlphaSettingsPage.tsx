/**
 * 本文件实现 Alpha 的 Workbench 设置页。
 * 页面仅在可见时刷新共享服务状态，服务控制仍通过 Rust 的幂等命令完成。
 */

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
import { SectionHeader } from "@/settings/components/SectionHeader";
import { SettingRow } from "@/settings/components/SettingRow";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

type Action =
  | "autoStart"
  | "check"
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
  const [action, setAction] = useState<Action>(null);

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

  useEffect(() => {
    if (!visible) return;
    void refresh(true);
    const timer = window.setInterval(() => void refresh(), 2500);
    const refreshOnFocus = () => void refresh();
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [refresh, visible]);

  const run = async (
    next: "start" | "stop" | "restart",
    operation: () => Promise<AlphaStatus>,
  ) => {
    setAction(next);
    try {
      setStatus(await operation());
    } catch (error) {
      toast.error(t(`actions.${next}Failed`), {
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

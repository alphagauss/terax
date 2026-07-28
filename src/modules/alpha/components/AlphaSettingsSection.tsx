/**
 * 本文件实现 Alpha 单例服务设置。
 * 页面只展示实时探测结果并调用幂等控制命令，多个窗口不会各自维护服务状态。
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

/** 渲染共享 Python 解释器配置与 Alpha 服务控制。 */
export function AlphaSettingsSection() {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<AlphaStatus | null>(null);
  const [check, setCheck] = useState<PythonCheck | null>(null);
  const [action, setAction] = useState<Action>(null);

  const refresh = useCallback(
    async (notifyOnError = false) => {
      try {
        setStatus(await getAlphaStatus());
      } catch (error) {
        if (notifyOnError) {
          toast.error(t("alpha.errors.status"), {
            description: String(error),
          });
        }
      }
    },
    [t],
  );

  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => void refresh(), 2500);
    const refreshOnFocus = () => void refresh();
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [refresh]);

  const run = async (
    next: "start" | "stop" | "restart",
    operation: () => Promise<AlphaStatus>,
  ) => {
    setAction(next);
    try {
      setStatus(await operation());
    } catch (error) {
      toast.error(t(`alpha.actions.${next}Failed`), {
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
        title: t("alpha.python.selectTitle"),
      });
      if (!selected || Array.isArray(selected)) return;
      await setAlphaPythonPath(selected);
      setCheck(null);
      await refresh();
    } catch (error) {
      toast.error(t("alpha.errors.python"), {
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
      toast.error(t("alpha.errors.python"), {
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
      toast.error(t("alpha.errors.setting"), {
        description: String(error),
      });
    } finally {
      setAction(null);
    }
  };

  const stateText = status?.running
    ? t("alpha.service.running", { port: status.port })
    : status?.issue === "portConflict"
      ? t("alpha.service.portConflict", { port: status.port })
      : status
        ? t("alpha.service.stopped")
        : t("alpha.service.loading");

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title={t("alpha.header.title")}
        description={t("alpha.header.description")}
      />

      <div className="flex flex-col gap-2">
        <Label>{t("alpha.python.label")}</Label>
        <SettingRow
          title={t("alpha.python.title")}
          description={t("alpha.python.description")}
          className="items-center"
        >
          <div className="flex max-w-90 items-center gap-2">
            <span
              className="max-w-62 truncate text-[11px] text-muted-foreground"
              title={status?.pythonPath ?? undefined}
            >
              {status?.pythonPath ?? t("alpha.python.unconfigured")}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={action !== null}
              onClick={() => void selectPython()}
            >
              {t("alpha.python.select")}
            </Button>
          </div>
        </SettingRow>
        {status?.configured ? (
          <SettingRow
            title={t("alpha.dependencies.title")}
            description={
              check?.error ??
              (check?.missingPackages.length
                ? t("alpha.dependencies.missing", {
                    packages: check.missingPackages.join(", "),
                  })
                : check?.version
                  ? t("alpha.dependencies.ready", { version: check.version })
                  : t("alpha.dependencies.description"))
            }
          >
            <Button
              size="sm"
              variant="outline"
              disabled={action !== null}
              onClick={() => void checkPython()}
            >
              {action === "check"
                ? t("alpha.dependencies.checking")
                : t("alpha.dependencies.check")}
            </Button>
          </SettingRow>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label>{t("alpha.service.label")}</Label>
        <SettingRow title={t("alpha.service.title")} description={stateText}>
          <span
            className={
              status?.running
                ? "text-[11px] font-medium text-emerald-500"
                : "text-[11px] font-medium text-muted-foreground"
            }
          >
            {status?.running
              ? t("alpha.service.statusRunning")
              : t("alpha.service.statusStopped")}
          </span>
        </SettingRow>
        <SettingRow
          title={t("alpha.autoStart.title")}
          description={t("alpha.autoStart.description")}
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
                  ? t("alpha.actions.restarting")
                  : t("alpha.actions.restart")}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={action !== null}
                onClick={() => void run("stop", stopAlpha)}
              >
                {action === "stop"
                  ? t("alpha.actions.stopping")
                  : t("alpha.actions.stop")}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              disabled={action !== null || !status?.configured}
              onClick={() => void run("start", startAlpha)}
            >
              {action === "start"
                ? t("alpha.actions.starting")
                : t("alpha.actions.start")}
            </Button>
          )}
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

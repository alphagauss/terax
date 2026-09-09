/** 常规设置中的手动截图入口，不加载或修改全局快捷键偏好。 */
import { Button } from "@/components/controls/button";
import { SettingGroup } from "@/components/settings/SettingGroup";
import { SettingRow } from "@/components/settings/SettingRow";
import { screenshotError } from "@/modules/screenshots/messages";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export function ScreenshotSettings() {
  const { t, i18n } = useTranslation("screenshot");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function capture() {
    setWaiting(true);
    setError(null);
    timer.current = setTimeout(() => {
      timer.current = null;
      void invoke("screenshot_start")
        .catch((reason: unknown) => setError(String(reason)))
        .finally(() => setWaiting(false));
    }, 2000);
  }

  return (
    <SettingGroup title={t("title")}>
      <SettingRow title={t("manual")} description={t("manualHint")}>
        <Button disabled={waiting} onClick={capture}>
          {t(waiting ? "waiting" : "capture")}
        </Button>
      </SettingRow>
      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {screenshotError(error, i18n.language)}
        </p>
      )}
    </SettingGroup>
  );
}

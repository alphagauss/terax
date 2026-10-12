/** 快捷键页面中的系统截图设置，复用共享偏好和原生注册状态。 */

import { SettingGroup } from "@/components/settings/SettingGroup";
import { SettingRow } from "@/components/settings/SettingRow";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Switch } from "@/components/ui/switch";
import { onSharedStoreChange } from "@/lib/sharedStore";
import { screenshotError } from "@/modules/screenshots/messages";
import {
  screenshotShortcut,
  screenshotShortcutTokens,
} from "@/modules/screenshots/shortcut";
import {
  SCREENSHOT_EVENT,
  type ScreenshotConfig,
  type ScreenshotStatus,
} from "@/modules/screenshots/types";
import { ShortcutRecorder } from "@/modules/shortcuts/components/ShortcutRecorder";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { reportError } from "@/lib/errors";
import { useTranslation } from "react-i18next";

export function ScreenshotShortcutSettings({
  search = "",
  isRecording,
  onStartRecording,
  onStopRecording,
}: {
  search?: string;
  isRecording: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
}) {
  const { t, i18n } = useTranslation("screenshot");
  const [status, setStatus] = useState<ScreenshotStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshVersion = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const next = await invoke<ScreenshotStatus>("screenshot_status");
      if (version === refreshVersion.current) setStatus(next);
    } catch (reason) {
      if (version === refreshVersion.current) setError(String(reason));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const subscriptions = [
      listen(SCREENSHOT_EVENT, () => {
        if (alive) void refresh();
      }),
      onSharedStoreChange("settings", async () => {
        if (alive) await refresh();
      }),
    ];
    void Promise.all(subscriptions)
      .then(() => {
        if (alive) return refresh();
      })
      .catch((reason: unknown) => {
        if (alive) setError(String(reason));
      });
    return () => {
      alive = false;
      ++refreshVersion.current;
      for (const subscription of subscriptions) {
        void subscription.then((unlisten) => unlisten()).catch(() => {});
      }
    };
  }, [refresh]);

  async function configure(patch: Partial<ScreenshotConfig>) {
    if (!status || pending) return;
    setPending(true);
    setError(null);
    try {
      await invoke("screenshot_configure", { patch });
      await refresh();
    } catch (reason) {
      reportError(t("common:errors.saveFailed"), { error: reason });
    } finally {
      setPending(false);
    }
  }

  const query = search.trim().toLowerCase();
  const searchable =
    `${t("globalTitle")} ${t("title")} ${t("enabled")} ${t("scope")} screenshot ${status?.config.shortcut ?? ""}`.toLowerCase();
  if (query && !searchable.includes(query)) return null;
  const failure = error ?? status?.error;
  if (!status)
    return failure ? (
      <p role="alert" className="text-xs text-destructive">
        {screenshotError(failure, i18n.language)}
      </p>
    ) : null;
  return (
    <SettingGroup title={t("globalTitle")}>
      <SettingRow title={t("enabled")} description={t("scope")}>
        <Switch
          aria-label={t("enabled")}
          checked={status.config.globalShortcutEnabled}
          disabled={pending || isRecording}
          onCheckedChange={(globalShortcutEnabled) => {
            void configure({ globalShortcutEnabled });
          }}
        />
      </SettingRow>
      <SettingRow title={t("shortcut")} description={t("shortcutHint")}>
        {isRecording ? (
          <ShortcutRecorder
            onCancel={onStopRecording}
            onRecord={(binding, code) => {
              onStopRecording();
              if (!code || code === "Unidentified") {
                setError("SCREENSHOT_SHORTCUT_INVALID");
                return;
              }
              void configure({ shortcut: screenshotShortcut(binding, code) });
            }}
          />
        ) : (
          <button
            type="button"
            aria-label={t("recordShortcut")}
            disabled={pending}
            onClick={() => {
              setError(null);
              onStartRecording();
            }}
            className="group flex min-w-[100px] cursor-pointer items-center justify-end gap-1 border-0 bg-transparent p-0 text-inherit disabled:cursor-default disabled:opacity-50"
          >
            <KbdGroup>
              {screenshotShortcutTokens(status.config.shortcut).map((token) => (
                <Kbd
                  key={token}
                  className="transition-colors group-hover:bg-accent group-hover:text-accent-foreground"
                >
                  {token}
                </Kbd>
              ))}
            </KbdGroup>
          </button>
        )}
      </SettingRow>
      {status.globalShortcutOwner && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t(status.registered ? "registered" : "notRegistered")}
        </p>
      )}
      {failure && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {screenshotError(failure, i18n.language)}
        </p>
      )}
    </SettingGroup>
  );
}

/**
 * 本文件呈现常规设置并连接对应的持久化偏好。
 * 外观选项的状态切换使用项目控制级动效，其他设置行为保持不变。
 */

import { Hint } from "@/components/controls/tooltip";
import { Input } from "@/components/controls/input";
import { Button } from "@/components/controls/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/controls/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/controls/tooltip";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { IS_MAC, IS_WINDOWS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  prepareOsNotification,
  sendOsNotification,
  type OsNotificationResult,
} from "@/modules/notifications/client";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type Language,
  setAgentNotifications,
  setAutostart,
  setExplorerGitDecorations,
  setLanguage,
  setRestoreWindowState,
  setShowHidden,
  setSourceControlShowUndoCommit,
  setTerminalCursorBlink,
  setTerminalCursorStyle,
  setTerminalFontFamily,
  setTerminalFontSize,
  setTerminalFontWeight,
  setTerminalLetterSpacing,
  setTerminalScrollback,
  setTerminalShell,
  setTerminalSmartCopyPaste,
  setTerminalWebglEnabled,
  setWorkspaceWindowMode,
  setZoomLevel,
  TERMINAL_FONT_SIZES,
  TERMINAL_SCROLLBACK_PRESETS,
  type ThemePref,
} from "@/modules/settings/store";
import { useTheme } from "@/modules/theme";
import {
  ComputerIcon,
  Moon02Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import i18n from "@/i18n";
import { reportError } from "@/lib/errors";
import { NetworkSettings } from "@/settings/components/NetworkSettings";
import { PageHeader, SectionHeading } from "@/components/layout/PageHeader";
import { SettingGroup } from "@/components/settings/SettingGroup";
import { SettingRow } from "@/components/settings/SettingRow";
import { ScreenshotSettings } from "@/modules/screenshots/ScreenshotSettings";

const APPEARANCE: {
  id: ThemePref;
  label: string;
  icon: typeof ComputerIcon;
}[] = [
  { id: "system", label: "System", icon: ComputerIcon },
  { id: "light", label: "Light", icon: Sun03Icon },
  { id: "dark", label: "Dark", icon: Moon02Icon },
];

const TERMINAL_FONT_WEIGHTS = [
  { value: "normal", labelKey: "normal" },
  { value: "500", labelKey: "medium" },
  { value: "600", labelKey: "semibold" },
  { value: "bold", labelKey: "bold" },
] as const;
const TERMINAL_CURSOR_STYLES = ["block", "bar", "underline"] as const;
const LETTER_SPACINGS = [-4, -3, -2, -1, 0, 1, 2, 3, 4] as const;

type ShellInfo = { name: string; path: string; integrated: boolean };
const SHELL_AUTO = "auto";
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.05;
const NOTIFICATION_TEST_DELAY_MS = 2_000;

type NotificationTestState =
  | OsNotificationResult["status"]
  | "idle"
  | "preparing"
  | "waiting"
  | "sending";

/** 常规设置分区，组合外观、网络、终端和启动等独立设置组。 */
export function GeneralSection() {
  const { t } = useTranslation("settings");
  const { mode, setMode } = useTheme();

  const autostart = usePreferencesStore((s) => s.autostart);
  const restoreWindowState = usePreferencesStore((s) => s.restoreWindowState);
  const workspaceWindowMode = usePreferencesStore((s) => s.workspaceWindowMode);
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const explorerGitDecorations = usePreferencesStore(
    (s) => s.explorerGitDecorations,
  );
  const sourceControlShowUndoCommit = usePreferencesStore(
    (s) => s.sourceControlShowUndoCommit,
  );
  const terminalWebglEnabled = usePreferencesStore(
    (s) => s.terminalWebglEnabled,
  );
  const terminalCursorBlink = usePreferencesStore((s) => s.terminalCursorBlink);
  const terminalCursorStyle = usePreferencesStore((s) => s.terminalCursorStyle);
  const terminalSmartCopyPaste = usePreferencesStore(
    (s) => s.terminalSmartCopyPaste,
  );
  const terminalFontFamily = usePreferencesStore((s) => s.terminalFontFamily);
  const terminalFontWeight = usePreferencesStore((s) => s.terminalFontWeight);
  const terminalShell = usePreferencesStore((s) => s.terminalShell);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [wslDistros, setWslDistros] = useState<{ name: string }[]>([]);
  const terminalLetterSpacing = usePreferencesStore(
    (s) => s.terminalLetterSpacing,
  );
  const terminalFontSize = usePreferencesStore((s) => s.terminalFontSize);
  const terminalScrollback = usePreferencesStore((s) => s.terminalScrollback);
  const zoomLevel = usePreferencesStore((s) => s.zoomLevel);
  const language = usePreferencesStore((s) => s.language);
  const agentNotifications = usePreferencesStore((s) => s.agentNotifications);
  const [notificationTest, setNotificationTest] =
    useState<NotificationTestState>("idle");
  const [notificationError, setNotificationError] = useState("");
  const notificationTestRun = useRef(0);
  const notificationTestTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const notificationTestPending =
    notificationTest === "preparing" ||
    notificationTest === "waiting" ||
    notificationTest === "sending";
  const [openWithAction, setOpenWithAction] = useState<
    "register" | "remove" | null
  >(null);

  /** 关闭提醒或离开设置时取消尚未发送的测试，并忽略过期回调。 */
  useEffect(() => {
    if (!agentNotifications) {
      setNotificationTest("idle");
      setNotificationError("");
    }
    return () => {
      ++notificationTestRun.current;
      if (notificationTestTimer.current !== null) {
        clearTimeout(notificationTestTimer.current);
        notificationTestTimer.current = null;
      }
    };
  }, [agentNotifications]);

  /** 先处理权限，再留两秒切换应用；失败原因直接显示在设置中。 */
  const testNotification = async () => {
    const run = ++notificationTestRun.current;
    setNotificationError("");
    setNotificationTest("preparing");
    const permission = await prepareOsNotification();
    if (
      run !== notificationTestRun.current ||
      !usePreferencesStore.getState().agentNotifications
    )
      return;
    if (permission.status !== "ready") {
      setNotificationTest(permission.status);
      if (permission.status === "failed")
        setNotificationError(permission.error);
      return;
    }
    setNotificationTest("waiting");
    notificationTestTimer.current = setTimeout(async () => {
      notificationTestTimer.current = null;
      if (
        run !== notificationTestRun.current ||
        !usePreferencesStore.getState().agentNotifications
      )
        return;
      setNotificationTest("sending");
      const result = await sendOsNotification(
        t("general.agents.notifications.test.notificationTitle"),
        t("general.agents.notifications.test.notificationBody"),
        { window: "auxiliary", request: { kind: "settings", tab: "general" } },
      );
      if (
        run !== notificationTestRun.current ||
        !usePreferencesStore.getState().agentNotifications
      )
        return;
      setNotificationTest(result.status);
      if (result.status === "failed") setNotificationError(result.error);
    }, NOTIFICATION_TEST_DELAY_MS);
  };

  useEffect(() => {
    let alive = true;
    void isEnabled()
      .then((on) => {
        if (!alive) return;
        if (on !== usePreferencesStore.getState().autostart) {
          void setAutostart(on);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    void invoke<ShellInfo[]>("pty_list_shells")
      .then(setShells)
      .catch(() => {});
    void invoke<{ name: string }[]>("wsl_list_distros")
      .then(setWslDistros)
      .catch(() => {});
  }, []);

  const onToggleAutostart = async (next: boolean) => {
    try {
      if (next) await enable();
      else await disable();
      await setAutostart(next);
    } catch (e) {
      console.error("autostart toggle failed", e);
    }
  };

  const registerOpenWith = async () => {
    setOpenWithAction("register");
    try {
      const executable = await invoke<string>("open_with_register");
      toast.success("Registered for Open With", { description: executable });
    } catch (error) {
      reportError(i18n.t("common:errors.registerFailed"), {
        error,
      });
    } finally {
      setOpenWithAction(null);
    }
  };

  const unregisterOpenWith = async () => {
    setOpenWithAction("remove");
    try {
      await invoke("open_with_unregister");
      toast.success("Unregistered Open With");
    } catch (error) {
      reportError(i18n.t("common:errors.unregisterFailed"), {
        error,
      });
    } finally {
      setOpenWithAction(null);
    }
  };

  return (
    <div className="flex flex-col gap-section">
      <PageHeader
        title={t("general.header.title")}
        description={t("general.header.description")}
      />

      <div className="flex flex-col gap-2">
        <SectionHeading>{t("general.appearance.label")}</SectionHeading>
        <div className="grid grid-cols-3 gap-2">
          {APPEARANCE.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setMode(o.id)}
              className={cn(
                "group flex h-12 items-center justify-center gap-2 rounded-lg border bg-card transition-[color,background-color,border-color,box-shadow] duration-control ease-standard focus-visible:outline-none focus-visible:ring-0",
                mode === o.id
                  ? "border-foreground/60 ring-1 ring-foreground/20"
                  : "border-border/60 hover:border-border",
              )}
            >
              <HugeiconsIcon icon={o.icon} size={18} strokeWidth={1.5} />
              <span className="text-xs">{t(`general.appearance.${o.id}`)}</span>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          <Trans
            i18nKey="general.appearance.seeThemes"
            components={{
              strong: <strong className="font-medium text-foreground" />,
            }}
          />
        </p>
      </div>

      <SettingGroup>
        <SettingRow
          title={t("general.language.label")}
          description={t("general.language.description")}
        >
          <Select
            value={language}
            onValueChange={(v) => void setLanguage(v as Language)}
          >
            <SelectTrigger value={language} className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_LANGUAGES.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingGroup>

      <div className="flex flex-col gap-2">
        <SectionHeading>{t("general.zoom.label")}</SectionHeading>
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {t("general.zoom.uiZoomLevel")}
            </span>
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {Math.round(zoomLevel * 100)}%
            </span>
          </div>
          <Slider
            value={[zoomLevel]}
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            onValueChange={(v) => void setZoomLevel(v[0] ?? 1)}
          />
        </div>
      </div>

      <NetworkSettings />
      <ScreenshotSettings />

      <SettingGroup title={t("general.explorer.label")}>
        <SettingRow
          title={t("general.explorer.showHidden.title")}
          description={t("general.explorer.showHidden.description")}
        >
          <Switch
            checked={showHidden}
            onCheckedChange={(v) => void setShowHidden(v)}
          />
        </SettingRow>
        <SettingRow
          title={t("general.explorer.gitDecorations.title")}
          description={t("general.explorer.gitDecorations.description")}
        >
          <Switch
            checked={explorerGitDecorations}
            onCheckedChange={(v) => void setExplorerGitDecorations(v)}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("general.sourceControl.label")}>
        <SettingRow
          title={t("general.sourceControl.showUndoCommit.title")}
          description={t("general.sourceControl.showUndoCommit.description")}
        >
          <Switch
            checked={sourceControlShowUndoCommit}
            onCheckedChange={(value) =>
              void setSourceControlShowUndoCommit(value)
            }
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("general.terminal.label")}>
        <SettingRow
          title={
            <span className="inline-flex items-center gap-1.5">
              {t("general.terminal.webgl.title")}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="img"
                    className="cursor-help text-[11px] text-muted-foreground leading-none"
                    aria-label={t("general.terminal.webgl.moreInfo")}
                  >
                    ⓘ
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-65">
                  {t("general.terminal.webgl.tooltip")}
                </TooltipContent>
              </Tooltip>
            </span>
          }
          description={t("general.terminal.webgl.description")}
        >
          <Switch
            checked={terminalWebglEnabled}
            onCheckedChange={(v) => void setTerminalWebglEnabled(v)}
          />
        </SettingRow>
        <SettingRow
          title={t("general.terminal.cursorBlink.title")}
          description={t("general.terminal.cursorBlink.description")}
        >
          <Switch
            checked={terminalCursorBlink}
            onCheckedChange={(v) => void setTerminalCursorBlink(v)}
          />
        </SettingRow>
        <SettingRow
          title={t("general.terminal.cursorStyle.title")}
          description={t("general.terminal.cursorStyle.description")}
        >
          <Select
            value={terminalCursorStyle}
            onValueChange={(value) => void setTerminalCursorStyle(value)}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_CURSOR_STYLES.map((style) => (
                <SelectItem key={style} value={style}>
                  {t(`general.terminal.cursorStyle.options.${style}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {!IS_MAC && (
          <SettingRow
            title={t("general.terminal.smartCopyPaste.title")}
            description={t("general.terminal.smartCopyPaste.description")}
          >
            <Switch
              checked={terminalSmartCopyPaste}
              onCheckedChange={(value) => void setTerminalSmartCopyPaste(value)}
            />
          </SettingRow>
        )}
        <FontFamilyInput
          value={terminalFontFamily}
          onCommit={(v) => void setTerminalFontFamily(v)}
        />
        <SettingRow
          title={t("general.terminal.fontWeight.title")}
          description={t("general.terminal.fontWeight.description")}
        >
          <Select
            value={terminalFontWeight}
            onValueChange={(v) => void setTerminalFontWeight(v)}
          >
            <SelectTrigger value={terminalFontWeight} className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_FONT_WEIGHTS.map((w) => (
                <SelectItem key={w.value} value={w.value}>
                  {t(`general.terminal.fontWeight.${w.labelKey}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={t("general.terminal.shell.title")}
          description={
            shells.find((s) => s.path === terminalShell)?.integrated === false
              ? t("general.terminal.shell.descriptionNonIntegrated")
              : wslDistros.length > 0
                ? t("general.terminal.shell.descriptionWsl")
                : t("general.terminal.shell.descriptionDefault")
          }
        >
          <Select
            value={terminalShell || SHELL_AUTO}
            onValueChange={(v) =>
              void setTerminalShell(v === SHELL_AUTO ? "" : v)
            }
          >
            <SelectTrigger value={terminalShell || SHELL_AUTO} className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SHELL_AUTO}>
                {t("general.terminal.shell.auto")}
              </SelectItem>
              {shells.map((s) => (
                <SelectItem key={s.path} value={s.path}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={t("general.terminal.letterSpacing.title")}
          description={t("general.terminal.letterSpacing.description")}
        >
          <Select
            value={String(terminalLetterSpacing)}
            onValueChange={(v) => void setTerminalLetterSpacing(Number(v))}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LETTER_SPACINGS.map((v) => (
                <SelectItem key={v} value={String(v)}>
                  {v > 0 ? `+${v}` : v} px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={t("general.terminal.fontSize.title")}
          description={t("general.terminal.fontSize.description")}
        >
          <Select
            value={String(terminalFontSize)}
            onValueChange={(v) => void setTerminalFontSize(Number(v))}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_FONT_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={t("general.terminal.scrollback.title")}
          description={t("general.terminal.scrollback.description")}
        >
          <Select
            value={String(terminalScrollback)}
            onValueChange={(v) => void setTerminalScrollback(Number(v))}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_SCROLLBACK_PRESETS.map((lines) => (
                <SelectItem key={lines} value={String(lines)}>
                  {t("general.terminal.scrollback.lines", {
                    count: lines.toLocaleString(),
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("general.agents.label")}>
        <SettingRow
          title={t("general.agents.notifications.title")}
          description={t("general.agents.notifications.description")}
        >
          <div className="flex items-center gap-2">
            <Hint
              content={t(
                `general.agents.notifications.test.hint.${notificationTest}`,
              )}
            >
              <Button
                aria-label={t(
                  `general.agents.notifications.test.hint.${notificationTest}`,
                )}
                type="button"
                variant="outline"
                size="xs"
                disabled={!agentNotifications || notificationTestPending}
                onClick={() => void testNotification()}
              >
                {t(
                  `general.agents.notifications.test.label.${notificationTest}`,
                )}
              </Button>
            </Hint>
            <Switch
              checked={agentNotifications}
              onCheckedChange={(value) => {
                setNotificationTest("idle");
                setNotificationError("");
                if (!value) {
                  ++notificationTestRun.current;
                  if (notificationTestTimer.current !== null) {
                    clearTimeout(notificationTestTimer.current);
                    notificationTestTimer.current = null;
                  }
                }
                void setAgentNotifications(value);
              }}
            />
          </div>
        </SettingRow>
        {notificationError ? (
          <p
            role="alert"
            className="px-4 pb-3 text-xs text-destructive break-words select-text"
          >
            {t("general.agents.notifications.test.error", {
              message: notificationError,
            })}
          </p>
        ) : null}
      </SettingGroup>

      <SettingGroup title={t("general.startup.label")}>
        <SettingRow
          title={t("general.startup.launchAtLogin.title")}
          description={t("general.startup.launchAtLogin.description")}
        >
          <Switch
            checked={autostart}
            onCheckedChange={(v) => void onToggleAutostart(v)}
          />
        </SettingRow>
        <SettingRow
          title={t("general.startup.restoreWindow.title")}
          description={t("general.startup.restoreWindow.description")}
        >
          <Switch
            checked={restoreWindowState}
            onCheckedChange={(v) => void setRestoreWindowState(v)}
          />
        </SettingRow>
        <SettingRow
          title={t("general.startup.workspaceWindows.title")}
          description={t("general.startup.workspaceWindows.description")}
        >
          <Select
            value={workspaceWindowMode}
            onValueChange={(v) =>
              void setWorkspaceWindowMode(
                v === "multiple" ? "multiple" : "single",
              )
            }
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="single">
                {t("general.startup.workspaceWindows.single")}
              </SelectItem>
              <SelectItem value="multiple">
                {t("general.startup.workspaceWindows.multiple")}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingGroup>

      {IS_WINDOWS ? (
        <SettingGroup title={t("general.openWith.label")}>
          <SettingRow
            title={t("general.openWith.fileAssociations.title")}
            description={t("general.openWith.fileAssociations.description")}
          >
            <div className="flex gap-2">
              <Button
                onClick={() => void registerOpenWith()}
                disabled={openWithAction !== null}
              >
                {openWithAction === "register"
                  ? t("general.openWith.registering")
                  : t("general.openWith.register")}
              </Button>
              <Button
                variant="outline"
                onClick={() => void unregisterOpenWith()}
                disabled={openWithAction !== null}
              >
                {openWithAction === "remove"
                  ? t("general.openWith.unregistering")
                  : t("general.openWith.unregister")}
              </Button>
            </div>
          </SettingRow>
        </SettingGroup>
      ) : null}
    </div>
  );
}

function FontFamilyInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  // Commit (and trim) only on blur/Enter so a trailing space can be typed
  // mid-edit, e.g. "JetBrains Mono ".
  const commit = () => {
    const next = draft.trim();
    if (next !== draft) setDraft(next);
    if (next !== value) onCommit(next);
  };

  return (
    <SettingRow
      title={t("general.terminal.fontFamily.title")}
      description={t("general.terminal.fontFamily.description")}
    >
      <Input
        type="text"
        value={draft}
        placeholder={t("general.terminal.fontFamily.placeholder")}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-48 font-mono"
      />
    </SettingRow>
  );
}

/**
 * 本文件呈现常规设置并连接对应的持久化偏好。
 * 外观选项的状态切换使用项目控制级动效，其他设置行为保持不变。
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { IS_WINDOWS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setLanguage,
  type Language,
  type ThemePref,
} from "@/modules/settings/store";
import {
  setAgentNotifications,
  setAutostart,
  setExplorerGitDecorations,
  setRestoreWindowState,
  setShowHidden,
  setSourceControlShowUndoCommit,
  setTerminalCursorBlink,
  setTerminalFontFamily,
  setTerminalFontSize,
  setTerminalFontWeight,
  setTerminalLetterSpacing,
  setTerminalScrollback,
  setTerminalShell,
  setTerminalWebglEnabled,
  setWorkspaceWindowMode,
  setZoomLevel,
  TERMINAL_FONT_SIZES,
  TERMINAL_SCROLLBACK_PRESETS,
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
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

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
const LETTER_SPACINGS = [-4, -3, -2, -1, 0, 1, 2, 3, 4] as const;

type ShellInfo = { name: string; path: string; integrated: boolean };
const SHELL_AUTO = "auto";
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.05;

/** 常规设置分区。 */
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
  const [openWithAction, setOpenWithAction] = useState<
    "register" | "remove" | null
  >(null);

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
      toast.error("Could not register for Open With", {
        description: String(error),
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
      toast.error("Could not remove Open With registration", {
        description: String(error),
      });
    } finally {
      setOpenWithAction(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title={t("general.header.title")}
        description={t("general.header.description")}
      />

      <div className="flex flex-col gap-2">
        <Label>{t("general.appearance.label")}</Label>
        <div className="grid grid-cols-3 gap-2">
          {APPEARANCE.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setMode(o.id)}
              className={cn(
                "group flex h-20 flex-col items-center justify-center gap-1.5 rounded-lg border bg-card transition-[color,background-color,border-color,box-shadow] duration-control ease-standard",
                mode === o.id
                  ? "border-foreground/60 ring-1 ring-foreground/20"
                  : "border-border/60 hover:border-border",
              )}
            >
              <HugeiconsIcon icon={o.icon} size={18} strokeWidth={1.5} />
              <span className="text-[11.5px]">
                {t(`general.appearance.${o.id}`)}
              </span>
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

      <div className="flex flex-col gap-2">
        <Label>{t("general.language.label")}</Label>
        <SettingRow
          title={t("general.language.label")}
          description={t("general.language.description")}
        >
          <Select
            value={language}
            onValueChange={(v) => void setLanguage(v as Language)}
          >
            <SelectTrigger value={language} className="h-8 w-40 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_LANGUAGES.map((l) => (
                <SelectItem key={l.id} value={l.id} className="text-[12px]">
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>{t("general.zoom.label")}</Label>
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11.5px] text-muted-foreground">
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

      <div className="flex flex-col gap-2">
        <Label>{t("general.explorer.label")}</Label>
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
      </div>

      <div className="flex flex-col gap-2">
        <Label>Source Control</Label>
        <SettingRow
          title="Show Undo Commit"
          description="Show an action on the latest commit that moves HEAD to its parent and keeps the changes staged."
        >
          <Switch
            checked={sourceControlShowUndoCommit}
            onCheckedChange={(value) =>
              void setSourceControlShowUndoCommit(value)
            }
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Terminal</Label>
        <SettingRow
          title={
            <span className="inline-flex items-center gap-1.5">
              Use WebGL renderer
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      role="img"
                      className="cursor-help text-[11px] text-muted-foreground/70 leading-none"
                      aria-label="More info about WebGL renderer"
                    >
                      ⓘ
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-65 text-[11px]">
                    xterm's WebGL renderer caches glyphs in a GPU texture atlas.
                    On some macOS setups (especially with Nerd Fonts), the atlas
                    corrupts and terminal text becomes unreadable. Turn this off
                    as a fallback — performance dips slightly, but text renders
                    correctly via the DOM renderer.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </span>
          }
          description="Hardware-accelerated rendering. Turn off if text shows corruption or blank tiles."
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
            <SelectTrigger
              value={terminalFontWeight}
              className="h-8 w-28 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_FONT_WEIGHTS.map((w) => (
                <SelectItem
                  key={w.value}
                  value={w.value}
                  className="text-[12px]"
                >
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
            <SelectTrigger
              value={terminalShell || SHELL_AUTO}
              className="h-8 w-40 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SHELL_AUTO} className="text-[12px]">
                {t("general.terminal.shell.auto")}
              </SelectItem>
              {shells.map((s) => (
                <SelectItem key={s.path} value={s.path} className="text-[12px]">
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Letter spacing"
          description="Extra horizontal space between characters (px). Use negative values to tighten Nerd Fonts."
        >
          <Select
            value={String(terminalLetterSpacing)}
            onValueChange={(v) => void setTerminalLetterSpacing(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LETTER_SPACINGS.map((v) => (
                <SelectItem key={v} value={String(v)} className="text-[12px]">
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
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_FONT_SIZES.map((size) => (
                <SelectItem
                  key={size}
                  value={String(size)}
                  className="text-[12px]"
                >
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
            <SelectTrigger size="sm" className="h-8 w-36 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_SCROLLBACK_PRESETS.map((lines) => (
                <SelectItem
                  key={lines}
                  value={String(lines)}
                  className="text-[12px]"
                >
                  {t("general.terminal.scrollback.lines", {
                    count: lines.toLocaleString(),
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>{t("general.agents.label")}</Label>
        <SettingRow
          title={t("general.agents.notifications.title")}
          description={t("general.agents.notifications.description")}
        >
          <Switch
            checked={agentNotifications}
            onCheckedChange={(v) => void setAgentNotifications(v)}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>{t("general.startup.label")}</Label>
        <div className="flex flex-col gap-2">
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
            title="Workspace windows"
            description="Single window reuses one window per Local, WSL, or SSH environment. Changes apply to windows opened afterwards."
          >
            <Select
              value={workspaceWindowMode}
              onValueChange={(v) =>
                void setWorkspaceWindowMode(
                  v === "multiple" ? "multiple" : "single",
                )
              }
            >
              <SelectTrigger className="h-8 w-56 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="single" className="text-[12px]">
                  Single window per environment
                </SelectItem>
                <SelectItem value="multiple" className="text-[12px]">
                  Multiple windows per environment
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
        </div>
      </div>

      {IS_WINDOWS ? (
        <div className="flex flex-col gap-2">
          <Label>Open With</Label>
          <SettingRow
            title="File associations"
            description="Add Open with Terax for files and folders, including multi-file selections. This does not change default apps."
          >
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void registerOpenWith()}
                disabled={openWithAction !== null}
              >
                {openWithAction === "register" ? "Registering..." : "Register"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void unregisterOpenWith()}
                disabled={openWithAction !== null}
              >
                {openWithAction === "remove"
                  ? "Unregistering..."
                  : "Unregister"}
              </Button>
            </div>
          </SettingRow>
        </div>
      ) : null}
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
      <input
        type="text"
        value={draft}
        placeholder={t("general.terminal.fontFamily.placeholder")}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="h-8 w-48 rounded-md border border-border bg-background px-2.5 text-[12px] outline-none focus:border-foreground/40"
      />
    </SettingRow>
  );
}

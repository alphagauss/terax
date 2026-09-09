/**
 * 本文件实现设置窗口的快捷键查询、录制和重置界面。
 *
 * 应用内快捷键编辑绑定覆盖值，系统截图快捷键使用独立分组并交给原生运行时注册。
 */

import { Hint } from "@/components/controls/tooltip";
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
import { Input } from "@/components/controls/input";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setShortcuts } from "@/modules/settings/store";
import { ScreenshotShortcutSettings } from "@/modules/screenshots/ScreenshotShortcutSettings";
import {
  getBindingTokens,
  type KeyBinding,
  SHORTCUT_GROUPS,
  SHORTCUTS,
  type Shortcut,
  type ShortcutId,
} from "@/modules/shortcuts/shortcuts";
import {
  ArrowTurnBackwardIcon,
  Delete02Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";
import { ShortcutRecorder } from "@/modules/shortcuts/components/ShortcutRecorder";
import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/layout/PageHeader";

/** 展示按功能分组的快捷键列表，并提供录制、冲突提示与重置入口。 */
export function ShortcutsSection() {
  const { t } = useTranslation();
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);
  const [search, setSearch] = useState("");
  const [recordingId, setRecordingId] = useState<
    ShortcutId | "screenshot" | null
  >(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);

  const filteredShortcuts = useMemo(() => {
    // Filter out internal/non-overridable shortcuts like tab.selectByIndex.
    const base = SHORTCUTS.filter((s) => s.id !== "tab.selectByIndex");
    if (!search) return base;
    const lower = search.toLowerCase();
    return base.filter(
      (s) =>
        t(`shortcuts:label.${s.id}`).toLowerCase().includes(lower) ||
        s.label.toLowerCase().includes(lower) ||
        t(`shortcuts:group.${s.group}`).toLowerCase().includes(lower) ||
        s.group.toLowerCase().includes(lower),
    );
  }, [search, t]);

  const onRecord = (id: ShortcutId, binding: KeyBinding) => {
    const next = { ...userShortcuts, [id]: [binding] };
    void setShortcuts(next);
    setRecordingId(null);
  };

  const onClear = (id: ShortcutId) => {
    const next = { ...userShortcuts, [id]: [] };
    void setShortcuts(next);
  };

  const onResetShortcut = (id: ShortcutId) => {
    const next = { ...userShortcuts };
    delete next[id];
    void setShortcuts(next);
  };

  const onResetAll = () => {
    void setShortcuts({});
    setResetDialogOpen(false);
  };

  return (
    <div className="flex flex-col gap-section">
      <div className="flex items-center justify-between">
        <PageHeader
          title={t("shortcuts.header.title")}
          description={t("shortcuts.header.description")}
        />
        <Button
          variant="outline"
          className="gap-1.5 px-2.5"
          onClick={() => setResetDialogOpen(true)}
        >
          <HugeiconsIcon
            icon={ArrowTurnBackwardIcon}
            size={12}
            strokeWidth={2}
          />
          {t("shortcuts.resetAll")}
        </Button>
      </div>

      <div className="relative">
        <HugeiconsIcon
          icon={Search01Icon}
          size={14}
          strokeWidth={2}
          className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          placeholder={t("shortcuts.searchPlaceholder")}
          value={search}
          onChange={(e) => {
            setRecordingId(null);
            setSearch(e.target.value);
          }}
          className="h-9 pl-9"
        />
      </div>

      <div className="flex flex-col gap-section">
        <ScreenshotShortcutSettings
          search={search}
          isRecording={recordingId === "screenshot"}
          onStartRecording={() => setRecordingId("screenshot")}
          onStopRecording={() => setRecordingId(null)}
        />
        {SHORTCUT_GROUPS.map((group) => {
          const items = filteredShortcuts.filter((s) => s.group === group);
          if (items.length === 0) return null;

          return (
            <div key={group} className="flex flex-col gap-3">
              <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                {t(`shortcuts:group.${group}`)}
              </h3>
              <div className="flex flex-col divide-y divide-border/40 rounded-lg border border-border/60 bg-card/40 overflow-hidden">
                {items.map((s) => (
                  <ShortcutRow
                    key={s.id}
                    shortcut={s}
                    isRecording={recordingId === s.id}
                    onStartRecording={() => setRecordingId(s.id)}
                    onStopRecording={() => setRecordingId(null)}
                    onRecord={(b) => onRecord(s.id, b)}
                    onClear={() => onClear(s.id)}
                    onReset={() => onResetShortcut(s.id)}
                    userBindings={userShortcuts[s.id]}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("shortcuts.resetDialog.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("shortcuts.resetDialog.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("shortcuts.resetDialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={onResetAll}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("shortcuts.resetAll")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ShortcutRow({
  shortcut,
  isRecording,
  onStartRecording,
  onStopRecording,
  onRecord,
  onClear,
  onReset,
  userBindings,
}: {
  shortcut: Shortcut;
  isRecording: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onRecord: (b: KeyBinding) => void;
  onClear: () => void;
  onReset: () => void;
  userBindings?: KeyBinding[];
}) {
  const { t } = useTranslation("settings");
  const bindings =
    userBindings !== undefined ? userBindings : shortcut.defaultBindings;
  const isModified = userBindings !== undefined;
  const hasBindings = bindings && bindings.length > 0;

  return (
    <div className="group flex items-center justify-between px-3 py-2.5 transition-colors hover:bg-interactive-hover">
      <div className="flex flex-col gap-0.5">
        <span className="text-[12.5px] font-medium">
          {t(`shortcuts:label.${shortcut.id}`)}
        </span>
      </div>

      <div className="flex items-center gap-2">
        {isRecording ? (
          <ShortcutRecorder onRecord={onRecord} onCancel={onStopRecording} />
        ) : (
          <>
            <button
              type="button"
              onClick={onStartRecording}
              className="flex min-w-[100px] cursor-pointer items-center justify-end gap-1 border-0 bg-transparent p-0 text-inherit"
            >
              {hasBindings ? (
                <KbdGroup>
                  {getBindingTokens(bindings[0]).map((t) => (
                    <Kbd
                      key={t}
                      className="group-hover:bg-accent group-hover:text-accent-foreground transition-colors"
                    >
                      {t}
                    </Kbd>
                  ))}
                </KbdGroup>
              ) : (
                <span className="text-[11px] text-muted-foreground italic">
                  {t("shortcuts.unassigned")}
                </span>
              )}
            </button>

            <div className="flex items-center gap-1">
              {isModified && (
                <Hint content={t("shortcuts.resetToDefault")}>
                  <Button
                    aria-label={t("shortcuts.resetToDefault")}
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={onReset}
                  >
                    <HugeiconsIcon icon={ArrowTurnBackwardIcon} size={12} />
                  </Button>
                </Hint>
              )}
              <Hint content={t("shortcuts.clearShortcut")}>
                <Button
                  aria-label={t("shortcuts.clearShortcut")}
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100"
                  onClick={onClear}
                >
                  <HugeiconsIcon icon={Delete02Icon} size={12} />
                </Button>
              </Hint>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

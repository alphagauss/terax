/** 应用内与系统快捷键共用的录制器，透传物理键码供原生快捷键转换。 */
import type { KeyBinding } from "@/modules/shortcuts/shortcuts";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

export function ShortcutRecorder({
  onRecord,
  onCancel,
}: {
  onRecord: (b: KeyBinding, code: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("settings");

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        onCancel();
        return;
      }

      const isMod = ["Control", "Shift", "Alt", "Meta"].includes(e.key);
      if (isMod) return;

      // 普通字符要求 Ctrl、Alt 或 Meta，拒绝只用 Shift 换档输入的字符。
      const hasPrimaryModifier = e.ctrlKey || e.altKey || e.metaKey;
      const isCharacterKey = e.key.length === 1;
      if (!hasPrimaryModifier && (!e.shiftKey || isCharacterKey)) {
        return;
      }
      onRecord(
        {
          key: e.key,
          ctrl: e.ctrlKey,
          shift: e.shiftKey,
          alt: e.altKey,
          meta: e.metaKey,
        },
        e.code,
      );
    };

    window.addEventListener("keydown", onDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onDown, { capture: true });
    };
  }, [onRecord, onCancel]);

  return (
    <div className="flex items-center gap-2 rounded bg-interactive-active px-2 py-1 text-[11px] ring-1 ring-accent">
      <span className="animate-pulse font-medium">
        {t("shortcuts.recording")}
      </span>
      <span className="text-muted-foreground">
        {t("shortcuts.escToCancel")}
      </span>
    </div>
  );
}

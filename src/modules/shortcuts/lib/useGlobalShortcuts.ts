import { usePreferencesStore } from "@/modules/settings/preferences";
import { useEffect, useRef } from "react";
import { matchBinding, SHORTCUTS, type ShortcutId } from "../shortcuts";

export type ShortcutHandler = (e: KeyboardEvent) => void;
export type ShortcutHandlers = Partial<Record<ShortcutId, ShortcutHandler>>;

export type UseGlobalShortcutsOptions = {
  isDisabled?: (id: ShortcutId, e: KeyboardEvent) => boolean;
};

export function useGlobalShortcuts(
  handlers: ShortcutHandlers,
  options?: UseGlobalShortcutsOptions,
) {
  const latest = useRef({ handlers, options });
  latest.current = { handlers, options };

  // Access the shortcuts from the store
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While an IME is composing (Chinese/Japanese/Korean), keystrokes belong
      // to candidate selection; preventing them would swallow the first input.
      if (e.isComposing || e.keyCode === 229) return;
      const { handlers, options } = latest.current;
      for (const s of SHORTCUTS) {
        if (e.repeat && !s.allowRepeat) continue;
        const bindings = userShortcuts[s.id] || s.defaultBindings;
        const isMatch = bindings.some((b) => matchBinding(e, b, s.id));
        if (!isMatch) continue;
        // 浮层输入不能透传给底层编辑器、终端或查找，宿主导航快捷键仍然可用。
        if (
          e.target instanceof Element &&
          e.target.closest("[data-workbench-page-overlay]") &&
          (s.id.startsWith("editor.") ||
            s.id.startsWith("blocks.") ||
            s.id === "terminal.clear" ||
            s.id === "search.focus")
        )
          return;
        if (options?.isDisabled?.(s.id, e)) return;
        const h = handlers[s.id];
        if (!h) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        h(e);
        return;
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [userShortcuts]);
}

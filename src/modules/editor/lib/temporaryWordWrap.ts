/** 本文件提供编辑器与只读 Diff 共用的临时自动换行状态和快捷键匹配。 */

import { usePreferencesStore } from "@/modules/settings/preferences";
import { matchBinding, SHORTCUTS } from "@/modules/shortcuts/shortcuts";
import { useCallback, useState } from "react";

const SHORTCUT = SHORTCUTS.find(
  (shortcut) => shortcut.id === "editor.toggleWordWrap",
);

/** 创建仅影响当前视图、不写入偏好设置的自动换行状态。 */
export function useTemporaryWordWrap() {
  const defaultValue = usePreferencesStore((state) => state.editorWordWrap);
  const [override, setOverride] = useState<boolean | null>(null);
  const toggle = useCallback(() => {
    setOverride(
      (current) => !(current ?? usePreferencesStore.getState().editorWordWrap),
    );
  }, []);
  return [override ?? defaultValue, toggle] as const;
}

/** 判断键盘事件是否匹配用户配置的临时自动换行快捷键。 */
export function matchesTemporaryWordWrapShortcut(
  event: KeyboardEvent,
): boolean {
  const bindings =
    usePreferencesStore.getState().shortcuts["editor.toggleWordWrap"] ??
    SHORTCUT?.defaultBindings ??
    [];
  return bindings.some((binding) =>
    matchBinding(event, binding, "editor.toggleWordWrap"),
  );
}

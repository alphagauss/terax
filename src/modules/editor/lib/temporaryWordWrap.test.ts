/** 本文件验证编辑器与只读 Diff 共用可自定义的自动换行快捷键。 */

// @vitest-environment happy-dom

import { usePreferencesStore } from "@/modules/settings/preferences";
import type { KeyBinding, ShortcutId } from "@/modules/shortcuts/shortcuts";
import { afterEach, describe, expect, it } from "vitest";
import { matchesTemporaryWordWrapShortcut } from "./temporaryWordWrap";

afterEach(() => {
  usePreferencesStore.setState({
    shortcuts: {} as Record<ShortcutId, KeyBinding[]>,
  });
});

function keyboardEvent(key: string, options: KeyboardEventInit = {}) {
  return new KeyboardEvent("keydown", { key, ...options });
}

describe("temporary word wrap shortcut", () => {
  it("matches the default binding", () => {
    expect(
      matchesTemporaryWordWrapShortcut(keyboardEvent("z", { altKey: true })),
    ).toBe(true);
    expect(matchesTemporaryWordWrapShortcut(keyboardEvent("z"))).toBe(false);
  });

  it("honors the user-defined binding", () => {
    usePreferencesStore.setState({
      shortcuts: {
        "editor.toggleWordWrap": [{ ctrl: true, shift: true, key: "w" }],
      } as Record<ShortcutId, KeyBinding[]>,
    });
    expect(
      matchesTemporaryWordWrapShortcut(keyboardEvent("z", { altKey: true })),
    ).toBe(false);
    expect(
      matchesTemporaryWordWrapShortcut(
        keyboardEvent("w", { ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(true);
  });
});

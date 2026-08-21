/**
 * 本文件验证全局快捷键注册表中的默认绑定。
 * 锁定设置页展示与各模块实际处理快捷键时共用同一份注册表定义。
 */

import { IS_MAC, MOD_PROP } from "@/lib/platform";
import { describe, expect, it } from "vitest";
import {
  getBindingTokens,
  type KeyBinding,
  matchBinding,
  SHORTCUT_GROUPS,
  SHORTCUTS,
} from "./shortcuts";

function keyboardEvent(
  key: string,
  code: string,
  modifiers: Partial<
    Pick<KeyboardEvent, "ctrlKey" | "shiftKey" | "altKey" | "metaKey">
  >,
): KeyboardEvent {
  return {
    key,
    code,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...modifiers,
  } as KeyboardEvent;
}

describe("folder picker shortcut", () => {
  it("registers Cmd/Ctrl+O as the default binding", () => {
    expect(SHORTCUTS).toContainEqual({
      id: "folder.open",
      label: "Open folder",
      group: "General",
      defaultBindings: [{ [MOD_PROP]: true, key: "o" }],
    });
  });
});

describe("shortcut display tokens", () => {
  it("空绑定不产生标签", () => {
    expect(getBindingTokens(undefined)).toEqual([]);
  });

  it("依次展示修饰键并规范化按键标签", () => {
    const primary = IS_MAC ? "⌃" : "Ctrl";
    const shift = IS_MAC ? "⇧" : "Shift";
    expect(getBindingTokens({ key: "k", ctrl: true, shift: true })).toEqual([
      primary,
      shift,
      "K",
    ]);
    expect(getBindingTokens({ key: "ArrowUp", alt: true }).slice(-1)[0]).toBe(
      "↑",
    );
    expect(getBindingTokens({ key: " " }).slice(-1)[0]).toBe("Space");
  });
});

describe("temporary word wrap shortcut", () => {
  it("registers Alt+Z as the default editor binding", () => {
    expect(SHORTCUTS).toContainEqual({
      id: "editor.toggleWordWrap",
      label: "Toggle word wrap",
      group: "Editor",
      defaultBindings: [{ alt: true, key: "z" }],
    });
  });
});

describe("fullscreen shortcut", () => {
  it("uses the platform-standard default binding", () => {
    expect(SHORTCUTS).toContainEqual({
      id: "view.fullscreen",
      label: "Toggle fullscreen",
      group: "View",
      defaultBindings: IS_MAC
        ? [{ ctrl: true, meta: true, key: "f" }]
        : [{ key: "F11" }],
    });
  });

  it("registers F10 as the zen mode toggle", () => {
    expect(SHORTCUTS).toContainEqual({
      id: "view.zenMode",
      label: "Toggle zen mode",
      group: "View",
      defaultBindings: [{ key: "F10" }],
    });
  });
});

describe("tab and Space navigation shortcuts", () => {
  it("shows Space shortcuts and registers ordered tab navigation", () => {
    expect(SHORTCUT_GROUPS).toContain("Spaces");
    expect(SHORTCUTS).toContainEqual({
      id: "tab.next",
      label: "Next recently used tab",
      group: "Tabs",
      defaultBindings: [{ ctrl: true, key: "Tab" }],
      allowRepeat: true,
    });
    expect(SHORTCUTS).toContainEqual({
      id: "tab.prev",
      label: "Previous recently used tab",
      group: "Tabs",
      defaultBindings: [{ ctrl: true, shift: true, key: "Tab" }],
      allowRepeat: true,
    });
    expect(SHORTCUTS).toContainEqual({
      id: "tab.nextPage",
      label: "Next tab by tab bar order",
      group: "Tabs",
      defaultBindings: [{ ctrl: true, key: "PageDown" }],
      allowRepeat: true,
    });
    expect(SHORTCUTS).toContainEqual({
      id: "tab.prevPage",
      label: "Previous tab by tab bar order",
      group: "Tabs",
      defaultBindings: [{ ctrl: true, key: "PageUp" }],
      allowRepeat: true,
    });
  });

  it.each([
    ["]", "}", "BracketRight"],
    ["[", "{", "BracketLeft"],
  ])(
    "matches shifted %s from its physical key",
    (bindingKey, eventKey, code) => {
      const binding: KeyBinding = {
        [MOD_PROP]: true,
        shift: true,
        key: bindingKey,
      };
      const modifiers = IS_MAC
        ? { metaKey: true, shiftKey: true }
        : { ctrlKey: true, shiftKey: true };

      expect(
        matchBinding(keyboardEvent(eventKey, code, modifiers), binding),
      ).toBe(true);
      expect(
        matchBinding(
          keyboardEvent(eventKey, code, {
            ...modifiers,
            shiftKey: false,
          }),
          binding,
        ),
      ).toBe(false);
      expect(
        matchBinding(keyboardEvent(eventKey, "Semicolon", modifiers), binding),
      ).toBe(false);
    },
  );

  it("does not treat an unshifted letter's physical position as its value", () => {
    expect(
      matchBinding(keyboardEvent("y", "KeyZ", { ctrlKey: true }), {
        ctrl: true,
        key: "z",
      }),
    ).toBe(false);
  });

  it("要求所有修饰键精确一致", () => {
    const binding: KeyBinding = { key: "c", ctrl: true };
    expect(
      matchBinding(keyboardEvent("C", "KeyC", { ctrlKey: true }), binding),
    ).toBe(true);
    expect(matchBinding(keyboardEvent("c", "KeyC", {}), binding)).toBe(false);
    expect(
      matchBinding(
        keyboardEvent("c", "KeyC", { ctrlKey: true, shiftKey: true }),
        binding,
      ),
    ).toBe(false);
  });

  it("Alt 改写字符时使用物理键回退", () => {
    expect(
      matchBinding(keyboardEvent("ç", "KeyC", { altKey: true }), {
        key: "c",
        alt: true,
      }),
    ).toBe(true);
    expect(
      matchBinding(keyboardEvent("ç", "KeyD", { altKey: true }), {
        key: "c",
        alt: true,
      }),
    ).toBe(false);
  });

  it("按索引选择标签只接受数字键", () => {
    expect(
      matchBinding(
        keyboardEvent("3", "Digit3", {}),
        { key: "1" },
        "tab.selectByIndex",
      ),
    ).toBe(true);
    expect(
      matchBinding(
        keyboardEvent("x", "KeyX", {}),
        { key: "1" },
        "tab.selectByIndex",
      ),
    ).toBe(false);
  });
});

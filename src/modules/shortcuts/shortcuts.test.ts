/**
 * 本文件验证全局快捷键注册表中的默认绑定。
 * 锁定设置页展示与各模块实际处理快捷键时共用同一份注册表定义。
 */

import { IS_MAC, MOD_PROP } from "@/lib/platform";
import { describe, expect, it } from "vitest";
import {
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
  ])("matches shifted %s from its physical key", (bindingKey, eventKey, code) => {
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
  });

  it("does not treat an unshifted letter's physical position as its value", () => {
    expect(
      matchBinding(keyboardEvent("y", "KeyZ", { ctrlKey: true }), {
        ctrl: true,
        key: "z",
      }),
    ).toBe(false);
  });
});

/**
 * 本文件测试终端键盘映射的纯逻辑。
 * 重点锁定平台差异、Shell 保留按键和智能剪贴板的选择感知行为。
 */

import { describe, expect, it } from "vitest";

import {
  terminalClipboardIntent,
  terminalDeleteSequence,
  terminalLineNavigationSequence,
  terminalReadlineSequence,
  terminalWordNavigationSequence,
  type TerminalKeyEvent,
} from "./keymap";

const evt = (partial: Partial<TerminalKeyEvent>): TerminalKeyEvent => ({
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  key: "",
  code: "",
  ...partial,
});

describe("terminalWordNavigationSequence", () => {
  it("maps Option+Left to readline word-left", () => {
    expect(
      terminalWordNavigationSequence(
        evt({ altKey: true, key: "ArrowLeft", code: "ArrowLeft" }),
      ),
    ).toBe("\x1bb");
  });

  it("maps Option+Right to readline word-right", () => {
    expect(
      terminalWordNavigationSequence(
        evt({ altKey: true, key: "ArrowRight", code: "ArrowRight" }),
      ),
    ).toBe("\x1bf");
  });

  it("does not remap plain arrows", () => {
    expect(
      terminalWordNavigationSequence(
        evt({ key: "ArrowLeft", code: "ArrowLeft" }),
      ),
    ).toBeNull();
  });
});

describe("terminalLineNavigationSequence", () => {
  it("maps Cmd+Left to readline line-start on macOS", () => {
    expect(
      terminalLineNavigationSequence(
        evt({ metaKey: true, key: "ArrowLeft", code: "ArrowLeft" }),
        { isMac: true },
      ),
    ).toBe("\x01");
  });

  it("maps Cmd+Right to readline line-end on macOS", () => {
    expect(
      terminalLineNavigationSequence(
        evt({ metaKey: true, key: "ArrowRight", code: "ArrowRight" }),
        { isMac: true },
      ),
    ).toBe("\x05");
  });

  it("does not remap Cmd+Arrow off macOS", () => {
    expect(
      terminalLineNavigationSequence(
        evt({ metaKey: true, key: "ArrowLeft", code: "ArrowLeft" }),
        { isMac: false },
      ),
    ).toBeNull();
  });

  it("does not remap Cmd+Option+Arrow (selection-style combos pass through)", () => {
    expect(
      terminalLineNavigationSequence(
        evt({
          metaKey: true,
          altKey: true,
          key: "ArrowLeft",
          code: "ArrowLeft",
        }),
        { isMac: true },
      ),
    ).toBeNull();
  });
});

describe("terminalDeleteSequence", () => {
  it("maps Cmd+Backspace to kill-to-line-start on macOS", () => {
    expect(
      terminalDeleteSequence(
        evt({ metaKey: true, key: "Backspace", code: "Backspace" }),
        { isMac: true },
      ),
    ).toBe("\x15");
  });

  it("maps Option+Backspace to kill-word-backward on macOS", () => {
    expect(
      terminalDeleteSequence(
        evt({ altKey: true, key: "Backspace", code: "Backspace" }),
        { isMac: true },
      ),
    ).toBe("\x17");
  });

  it("maps Ctrl+Backspace to kill-word-backward off macOS", () => {
    expect(
      terminalDeleteSequence(
        evt({ ctrlKey: true, key: "Backspace", code: "Backspace" }),
        { isMac: false },
      ),
    ).toBe("\x17");
  });

  it("does not remap Ctrl+Backspace on macOS (reserved for native readline binding)", () => {
    expect(
      terminalDeleteSequence(
        evt({ ctrlKey: true, key: "Backspace", code: "Backspace" }),
        { isMac: true },
      ),
    ).toBeNull();
  });

  it("does not remap Cmd+Backspace off macOS", () => {
    expect(
      terminalDeleteSequence(
        evt({ metaKey: true, key: "Backspace", code: "Backspace" }),
        { isMac: false },
      ),
    ).toBeNull();
  });

  it("does not remap plain Backspace", () => {
    expect(
      terminalDeleteSequence(evt({ key: "Backspace", code: "Backspace" }), {
        isMac: true,
      }),
    ).toBeNull();
  });
});

describe("terminalReadlineSequence", () => {
  const remaps = [
    [
      "line navigation",
      evt({ metaKey: true, key: "ArrowLeft", code: "ArrowLeft" }),
      "\x01",
    ],
    [
      "word navigation",
      evt({ altKey: true, key: "ArrowRight", code: "ArrowRight" }),
      "\x1bf",
    ],
    [
      "deletion",
      evt({ metaKey: true, key: "Backspace", code: "Backspace" }),
      "\x15",
    ],
  ] as const;

  it.each(remaps)(
    "applies %s on the normal screen",
    (_name, event, sequence) => {
      expect(
        terminalReadlineSequence(event, {
          isMac: true,
          isAlternateScreen: false,
        }),
      ).toBe(sequence);
    },
  );

  it.each(remaps)("leaves %s to the alternate screen", (_name, event) => {
    expect(
      terminalReadlineSequence(event, {
        isMac: true,
        isAlternateScreen: true,
      }),
    ).toBeNull();
  });
});

describe("terminalClipboardIntent", () => {
  const options = (
    overrides: Partial<Parameters<typeof terminalClipboardIntent>[1]> = {},
  ) => ({
    isMac: false,
    smartCopyPaste: true,
    hasSelection: false,
    ...overrides,
  });

  it("always supports Ctrl+Shift+C/V off macOS", () => {
    expect(
      terminalClipboardIntent(
        evt({ ctrlKey: true, shiftKey: true, code: "KeyC", key: "c" }),
        options({ smartCopyPaste: false }),
      ),
    ).toBe("copy");
    expect(
      terminalClipboardIntent(
        evt({ ctrlKey: true, shiftKey: true, code: "KeyV", key: "v" }),
        options({ smartCopyPaste: false }),
      ),
    ).toBe("paste");
  });

  it("copies with Ctrl+C only when smart mode has a selection", () => {
    expect(
      terminalClipboardIntent(
        evt({ ctrlKey: true, code: "KeyC", key: "c" }),
        options({ hasSelection: true }),
      ),
    ).toBe("copy");
    expect(
      terminalClipboardIntent(
        evt({ ctrlKey: true, code: "KeyC", key: "c" }),
        options(),
      ),
    ).toBeNull();
  });

  it("pastes with Ctrl+V only when smart mode is enabled", () => {
    expect(
      terminalClipboardIntent(
        evt({ ctrlKey: true, code: "KeyV", key: "v" }),
        options(),
      ),
    ).toBe("paste");
    expect(
      terminalClipboardIntent(
        evt({ ctrlKey: true, code: "KeyV", key: "v" }),
        options({ smartCopyPaste: false }),
      ),
    ).toBeNull();
  });

  it("does not intercept Ctrl-based clipboard keys on macOS", () => {
    expect(
      terminalClipboardIntent(
        evt({ ctrlKey: true, shiftKey: true, code: "KeyC", key: "c" }),
        options({ isMac: true, hasSelection: true }),
      ),
    ).toBeNull();
  });

  it("Cmd+V 和 Shift+Insert 进入统一粘贴，Cmd+C 保留原生复制", () => {
    expect(
      terminalClipboardIntent(
        evt({ metaKey: true, code: "KeyV", key: "v" }),
        options({ isMac: true }),
      ),
    ).toBe("paste");
    expect(
      terminalClipboardIntent(
        evt({ metaKey: true, code: "KeyC", key: "c" }),
        options({ isMac: true }),
      ),
    ).toBeNull();
    expect(
      terminalClipboardIntent(
        evt({ shiftKey: true, key: "Insert" }),
        options({ smartCopyPaste: false }),
      ),
    ).toBe("paste");
  });

  it("supports uppercase and non-Latin keyboard layouts", () => {
    expect(
      terminalClipboardIntent(
        evt({ ctrlKey: true, key: "C" }),
        options({ hasSelection: true }),
      ),
    ).toBe("copy");
    expect(
      terminalClipboardIntent(
        evt({ ctrlKey: true, code: "KeyV", key: "м" }),
        options(),
      ),
    ).toBe("paste");
  });

  it("ignores AltGr and unrelated keys", () => {
    expect(
      terminalClipboardIntent(
        evt({ ctrlKey: true, altKey: true, code: "KeyC", key: "c" }),
        options({ hasSelection: true }),
      ),
    ).toBeNull();
    expect(
      terminalClipboardIntent(
        evt({ ctrlKey: true, code: "KeyX", key: "x" }),
        options({ hasSelection: true }),
      ),
    ).toBeNull();
  });
});

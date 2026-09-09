/** 系统截图使用物理键编码，避免 Shift、Option 和键盘布局把按键变成不可解析字符。 */
import { IS_MAC } from "@/lib/platform";
import {
  getBindingTokens,
  type KeyBinding,
} from "@/modules/shortcuts/shortcuts";

export function screenshotShortcut(binding: KeyBinding, code: string): string {
  return [
    binding.ctrl && "Control",
    binding.alt && "Alt",
    binding.shift && "Shift",
    binding.meta && "Super",
    code,
  ]
    .filter(Boolean)
    .join("+");
}

const KEY_LABELS: Record<string, string> = {
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Space: " ",
};

export function screenshotShortcutTokens(shortcut: string): string[] {
  const parts = shortcut.split("+");
  const code = parts.pop() ?? "";
  const modifiers = new Set(parts.map((part) => part.toLowerCase()));
  const commandOrControl =
    modifiers.has("commandorcontrol") || modifiers.has("cmdorctrl");
  return getBindingTokens({
    key: KEY_LABELS[code] ?? code.replace(/^(Key|Digit)(?=.)/, ""),
    ctrl:
      modifiers.has("control") ||
      modifiers.has("ctrl") ||
      (commandOrControl && !IS_MAC),
    alt: modifiers.has("alt") || modifiers.has("option"),
    shift: modifiers.has("shift"),
    meta:
      modifiers.has("super") ||
      modifiers.has("command") ||
      modifiers.has("cmd") ||
      (commandOrControl && IS_MAC),
  });
}

/**
 * 本文件定义终端键盘事件的纯映射规则。
 * 负责 readline 导航、删除和剪贴板意图分类，不直接访问 PTY 或系统剪贴板。
 */

export type TerminalKeyEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "key" | "code"
>;

export type PlatformOpts = { isMac: boolean };

export function terminalWordNavigationSequence(
  event: TerminalKeyEvent,
): string | null {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === "ArrowLeft" || event.code === "ArrowLeft") return "\x1bb";
  if (event.key === "ArrowRight" || event.code === "ArrowRight") return "\x1bf";
  return null;
}

/** Cmd+Left/Right → readline line-start (Ctrl+A) / line-end (Ctrl+E).
 * macOS-only — Cmd doesn't exist as a navigation modifier elsewhere. */
export function terminalLineNavigationSequence(
  event: TerminalKeyEvent,
  opts: PlatformOpts,
): string | null {
  if (!opts.isMac) return null;
  if (!event.metaKey || event.altKey || event.ctrlKey) return null;
  if (event.key === "ArrowLeft" || event.code === "ArrowLeft") return "\x01";
  if (event.key === "ArrowRight" || event.code === "ArrowRight") return "\x05";
  return null;
}

/** Modifier+Backspace deletion:
 *   macOS  Cmd+Backspace    → Ctrl+U (kill-to-line-start)
 *   macOS  Option+Backspace → Ctrl+W (kill-word-backward)
 *   Other  Ctrl+Backspace   → Ctrl+W (kill-word-backward)
 */
export function terminalDeleteSequence(
  event: TerminalKeyEvent,
  opts: PlatformOpts,
): string | null {
  if (event.key !== "Backspace" && event.code !== "Backspace") return null;
  if (opts.isMac) {
    if (event.metaKey && !event.altKey && !event.ctrlKey) return "\x15";
    if (event.altKey && !event.metaKey && !event.ctrlKey) return "\x17";
    return null;
  }
  if (event.ctrlKey && !event.altKey && !event.metaKey) return "\x17";
  return null;
}

export type TerminalClipboardIntent = "copy" | "paste";

export type TerminalClipboardOptions = {
  isMac: boolean;
  smartCopyPaste: boolean;
  hasSelection: boolean;
};

/**
 * 判断按键是否应由终端剪贴板处理。
 *
 * macOS 保留原生 Cmd+C/V 和 Ctrl+C 中断语义。其他平台始终支持
 * Ctrl+Shift+C/V；智能模式还会让有选区的 Ctrl+C 复制，并让 Ctrl+V 粘贴。
 */
export function terminalClipboardIntent(
  event: TerminalKeyEvent,
  opts: TerminalClipboardOptions,
): TerminalClipboardIntent | null {
  if (opts.isMac) return null;
  if (!event.ctrlKey || event.altKey || event.metaKey) return null;

  // 同时匹配物理键位和字符，保证非拉丁键盘布局仍可使用通用组合键。
  const key = event.key.toLowerCase();
  const isCopy = event.code === "KeyC" || key === "c";
  const isPaste = event.code === "KeyV" || key === "v";
  if (!isCopy && !isPaste) return null;

  if (event.shiftKey) return isCopy ? "copy" : "paste";
  if (!opts.smartCopyPaste) return null;
  if (isPaste) return "paste";
  return opts.hasSelection ? "copy" : null;
}

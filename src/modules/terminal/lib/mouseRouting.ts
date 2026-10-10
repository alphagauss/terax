/**
 * 本文件定义终端鼠标事件在本地视图与 TUI 之间的路由规则。
 * 只处理平台修饰键和滚轮单位换算，不直接操作 xterm 或 PTY。
 */

export type TerminalMouseTrackingMode =
  | "none"
  | "x10"
  | "vt200"
  | "drag"
  | "any";

/** 只有主键原地点击才选择整块，水平拖选和修饰键选择继续交给 xterm。 */
export function isBlockClick(
  start: { x: number; y: number } | null,
  event: Pick<
    MouseEvent,
    | "clientX"
    | "clientY"
    | "button"
    | "shiftKey"
    | "altKey"
    | "ctrlKey"
    | "metaKey"
  >,
): boolean {
  return (
    !!start &&
    event.button === 0 &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 4
  );
}

export type TerminalMouseModifierEvent = Pick<
  MouseEvent,
  "altKey" | "shiftKey"
>;

/**
 * 判断当前鼠标事件是否按住平台对应的 TUI 旁路键。
 *
 * Windows/Linux 使用 Shift，macOS 使用 Option，以复用 xterm 的原生强制选择。
 */
export function terminalMouseOverrideHeld(
  event: TerminalMouseModifierEvent,
  isMac: boolean,
): boolean {
  return isMac ? event.altKey : event.shiftKey;
}

/**
 * 判断鼠标事件是否应由 Terax 本地处理。
 *
 * 未开启鼠标上报时始终使用本地行为；TUI 开启上报后仅在按住旁路键时使用本地行为。
 */
export function shouldUseLocalTerminalMouse(
  mode: TerminalMouseTrackingMode,
  event: TerminalMouseModifierEvent,
  isMac: boolean,
): boolean {
  return mode === "none" || terminalMouseOverrideHeld(event, isMac);
}

/**
 * 将浏览器滚轮增量换算为终端行数。
 *
 * 支持像素、行和页三种 deltaMode；调用方负责累计触控板产生的小数行。
 */
export function terminalWheelDeltaRows(
  deltaY: number,
  deltaMode: number,
  cellHeight: number,
  viewportRows: number,
): number {
  if (deltaMode === 1) return deltaY;
  if (deltaMode === 2) return deltaY * viewportRows;
  return deltaY / Math.max(1, cellHeight);
}

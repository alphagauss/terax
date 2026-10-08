/**
 * 本文件导出终端模块供 Workbench 与应用外壳使用的公共能力。
 * 所有前端终端操作统一以终端标签 ID 定位。
 */

export { useTerminalFileDrop } from "./lib/useTerminalFileDrop";
export {
  subscribeTerminalCommandState,
  terminalCommandState,
  type TerminalCommandState,
} from "./lib/commandState";
export {
  clearFocusedTerminal,
  disposeSession,
  executeCommandInSession,
  terminalNeedsCloseConfirmation,
  terminalIdForPty,
  navigateFocusedBlocks,
  respawnSession,
  whenSessionReady,
  writeToSession,
} from "./lib/useTerminalSession";
export { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
export { TerminalView } from "./TerminalView";

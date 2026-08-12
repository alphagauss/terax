/**
 * 本文件定义终端退出原因和 SSH Runtime 恢复策略。
 * 传输关闭与普通 shell 退出保持可区分，自动重连替换 PTY 时保留本地滚动历史。
 */

export const REMOTE_TRANSPORT_CLOSED_EXIT_CODE = -255;
export const EXIT_ALTERNATE_SCREEN_SEQUENCE = "\x1b[?1049l";
export const REMOTE_RECONNECT_RESET_SEQUENCE =
  "\x1b[!p\x1b[?9;1000;1002;1003;1006;1016l\x1b[0m\x1b[?25h";

export type TerminalRespawnMode = "clear" | "preserve-history";

export function isRecoverableRemoteExit(code: number): boolean {
  return code === REMOTE_TRANSPORT_CLOSED_EXIT_CODE;
}

/** 返回远端 PTY 在新连接代际中的替换模式。 */
export function remotePtyRespawnMode(
  currentEpoch: number | null,
  connectedEpoch: number | null,
): TerminalRespawnMode | null {
  return connectedEpoch !== null && currentEpoch !== connectedEpoch
    ? "preserve-history"
    : null;
}

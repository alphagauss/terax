/**
 * 本文件定义终端退出原因中与 SSH Runtime 恢复相关的纯判断。
 * 传输关闭与普通 shell 退出保持可区分，epoch 变化负责触发 PTY 替换。
 */

export const REMOTE_TRANSPORT_CLOSED_EXIT_CODE = -255;

export function isRecoverableRemoteExit(code: number): boolean {
  return code === REMOTE_TRANSPORT_CLOSED_EXIT_CODE;
}

/** 判断已存在的远端 PTY 是否属于过期 Runtime。 */
export function shouldReplaceRemotePty(
  currentEpoch: number | null,
  connectedEpoch: number | null,
): boolean {
  return connectedEpoch !== null && currentEpoch !== connectedEpoch;
}

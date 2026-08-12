/**
 * 本文件维护终端 Shell Integration 报告的命令状态。
 * 状态按终端标签 ID 隔离；会话未创建或已销毁时统一视为不可用。
 */

export type TerminalCommandState =
  | "unknown"
  | "idle"
  | "running"
  | "unavailable";

const states = new Map<number, TerminalCommandState>();
const listeners = new Map<number, Set<() => void>>();

/** 返回终端当前命令状态，尚未注册的会话视为不可用。 */
export function terminalCommandState(terminalId: number): TerminalCommandState {
  return states.get(terminalId) ?? "unavailable";
}

/** 更新命令状态，并仅在可观察状态发生变化时通知订阅者。 */
export function setTerminalCommandState(
  terminalId: number,
  state: TerminalCommandState,
): void {
  if (terminalCommandState(terminalId) === state) return;
  states.set(terminalId, state);
  const current = listeners.get(terminalId);
  if (current) for (const listener of current) listener();
}

/** 清除终端状态；仍在监听的调用方会收到一次不可用通知。 */
export function clearTerminalCommandState(terminalId: number): void {
  const changed = terminalCommandState(terminalId) !== "unavailable";
  states.delete(terminalId);
  if (!changed) return;
  const current = listeners.get(terminalId);
  if (current) for (const listener of current) listener();
}

/** 订阅指定终端的命令状态变化，允许在会话创建前登记。 */
export function subscribeTerminalCommandState(
  terminalId: number,
  listener: () => void,
): () => void {
  const current = listeners.get(terminalId) ?? new Set();
  current.add(listener);
  listeners.set(terminalId, current);
  return () => {
    current.delete(listener);
    if (current.size === 0) listeners.delete(terminalId);
  };
}

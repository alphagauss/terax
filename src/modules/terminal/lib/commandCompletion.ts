/**
 * 本文件发布终端命令完成通知，供需要在 Shell 操作后校验外部状态的模块按需订阅。
 */

type CommandFinishedListener = (cwd: string | null) => void;

const listeners = new Set<CommandFinishedListener>();

/** 由终端运行时在一次真实命令从运行态回到提示符时调用。 */
export function notifyTerminalCommandFinished(cwd: string | null): void {
  for (const listener of listeners) listener(cwd);
}

/** 订阅当前应用进程内所有终端的命令完成通知。 */
export function subscribeTerminalCommandFinished(
  listener: CommandFinishedListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

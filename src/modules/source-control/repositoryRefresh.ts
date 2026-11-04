/**
 * 本文件实现仓库状态刷新的串行合并队列。
 * 被动校验复用进行中的读取；真实失效追加一次尾随读取，避免文件事件或 Git 操作丢失。
 */

type RefreshRunner = () => Promise<void>;

/** 创建串行队列；check 只加入当前任务，invalidate 保证读取期间的变化得到补查。 */
export function createRepositoryRefreshQueue(
  run: RefreshRunner,
  trailingDelay: () => number = () => 0,
): {
  request: (mode?: "invalidate" | "check") => Promise<void>;
  cancelPending: () => void;
} {
  let pending = false;
  let inflight: Promise<void> | null = null;
  let releaseDelay: (() => void) | undefined;

  const request = (
    mode: "invalidate" | "check" = "invalidate",
  ): Promise<void> => {
    if (inflight && mode === "check") return inflight;
    pending = true;
    if (inflight) return inflight;

    const task = (async () => {
      while (pending) {
        pending = false;
        await run();
        if (pending) {
          const delay = trailingDelay();
          if (delay > 0)
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                releaseDelay = undefined;
                resolve();
              }, delay);
              releaseDelay = () => {
                clearTimeout(timer);
                releaseDelay = undefined;
                resolve();
              };
            });
        }
      }
    })().finally(() => {
      if (inflight === task) inflight = null;
      // 最后一轮 await 与清理之间也可能收到失效，调用方须等待这次补查。
      if (pending) return request();
    });
    inflight = task;
    return task;
  };

  return {
    request,
    cancelPending: () => {
      pending = false;
      releaseDelay?.();
    },
  };
}

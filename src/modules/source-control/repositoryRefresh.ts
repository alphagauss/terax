/**
 * 本文件实现仓库状态刷新的串行合并队列。
 * 被动校验复用进行中的读取；真实失效追加一次尾随读取，避免文件事件或 Git 操作丢失。
 */

type RefreshRunner = (snapshotReady: () => void) => Promise<void>;
type RefreshMode = "invalidate" | "check" | "mutation";

/** 创建串行队列；check 只加入当前任务，invalidate 保证读取期间的变化得到补查。 */
export function createRepositoryRefreshQueue(
  run: RefreshRunner,
  trailingDelay: () => number = () => 0,
): {
  request: (mode?: RefreshMode) => Promise<void>;
  cancelPending: () => void;
} {
  let pending = false;
  let inflight: Promise<void> | null = null;
  let releaseDelay: (() => void) | undefined;
  let urgent = false;
  let startedRound = 0;
  const waiters = new Set<{ round: number; resolve: () => void }>();
  const settleSnapshot = (round: number) => {
    for (const waiter of waiters) {
      if (waiter.round <= round) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  };

  const request = (mode: RefreshMode = "invalidate"): Promise<void> => {
    if (inflight && mode === "check") return inflight;
    // 操作完成必须等待下一轮启动后的快照，不能复用操作之前开始的读取。
    const snapshot =
      mode === "mutation"
        ? new Promise<void>((resolve) => {
            waiters.add({ round: startedRound + 1, resolve });
          })
        : null;
    pending = true;
    if (mode === "mutation") {
      urgent = true;
      releaseDelay?.();
    }
    if (inflight) return snapshot ?? inflight;

    const task = (async () => {
      while (pending) {
        pending = false;
        urgent = false;
        const round = ++startedRound;
        try {
          await run(() => settleSnapshot(round));
        } finally {
          // 隐藏、切换上下文或读取失败也必须结束等待，错误状态由控制器拥有。
          settleSnapshot(round);
        }
        if (pending) {
          const delay = urgent ? 0 : trailingDelay();
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
    return snapshot ?? task;
  };

  return {
    request,
    cancelPending: () => {
      pending = false;
      urgent = false;
      settleSnapshot(Infinity);
      releaseDelay?.();
    },
  };
}

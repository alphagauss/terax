/**
 * 本文件实现仓库状态刷新的串行合并队列。
 * 被动校验复用进行中的读取；真实失效追加一次尾随读取，避免文件事件或 Git 操作丢失。
 */

type RefreshRunner = () => Promise<void>;

/** 创建串行队列；check 只加入当前任务，invalidate 保证读取期间的变化得到补查。 */
export function createRepositoryRefreshQueue(run: RefreshRunner): {
  request: (mode?: "invalidate" | "check") => Promise<void>;
} {
  let pending = false;
  let inflight: Promise<void> | null = null;

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
      }
    })().finally(() => {
      if (inflight === task) inflight = null;
      // 最后一轮 await 与清理之间也可能收到失效，调用方须等待这次补查。
      if (pending) return request();
    });
    inflight = task;
    return task;
  };

  return { request };
}

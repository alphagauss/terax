/**
 * 本文件实现仓库状态刷新的串行合并队列。
 * 刷新期间到达的新请求会在当前请求结束后继续执行，避免文件事件或 Git 操作失效丢失。
 */

type RefreshRunner = () => Promise<void>;

/** 创建一个串行刷新队列，并把进行中收到的请求合并为一次后续刷新。 */
export function createRepositoryRefreshQueue(run: RefreshRunner): {
  request: () => Promise<void>;
} {
  let pending = false;
  let inflight: Promise<void> | null = null;

  const request = (): Promise<void> => {
    pending = true;
    if (inflight) return inflight;

    const task = (async () => {
      while (pending) {
        pending = false;
        await run();
      }
    })().finally(() => {
      if (inflight === task) inflight = null;
    });
    inflight = task;
    return task;
  };

  return { request };
}

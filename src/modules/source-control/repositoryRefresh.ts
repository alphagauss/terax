/**
 * 本文件实现仓库状态刷新的串行合并队列。
 * 刷新期间到达的新请求会在当前请求结束后继续执行，避免文件事件或 Git 操作失效丢失。
 */

export type RepositoryRefreshMode = "auto" | "always" | "never";

type RefreshRunner = (mode: RepositoryRefreshMode) => Promise<void>;

function mergeMode(
  current: RepositoryRefreshMode | null,
  next: RepositoryRefreshMode,
): RepositoryRefreshMode {
  if (current === "always" || next === "always") return "always";
  if (current === "auto" || next === "auto") return "auto";
  return "never";
}

/** 创建一个串行刷新队列，并把进行中收到的请求合并为一次后续刷新。 */
export function createRepositoryRefreshQueue(run: RefreshRunner): {
  request: (mode: RepositoryRefreshMode) => Promise<void>;
} {
  let pending: RepositoryRefreshMode | null = null;
  let inflight: Promise<void> | null = null;

  const request = (mode: RepositoryRefreshMode): Promise<void> => {
    pending = mergeMode(pending, mode);
    if (inflight) return inflight;

    const task = (async () => {
      while (pending) {
        const next = pending;
        pending = null;
        await run(next);
      }
    })().finally(() => {
      if (inflight === task) inflight = null;
    });
    inflight = task;
    return task;
  };

  return { request };
}

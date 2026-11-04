import { resetViewCachesForTests } from "@/modules/view-state/cache";
/**
 * 本文件测试 Repository Controller 的真实刷新与上下文切换。
 * 锁定相同状态仍推进 revision、嵌套路径重新发现仓库，以及陈旧请求不得覆盖新上下文。
 */

// @vitest-environment happy-dom

import type { GitPanelSnapshot } from "@/modules/ai/lib/native";
import { notifyTerminalCommandFinished } from "@/modules/terminal/lib/commandCompletion";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gitPanelSnapshot: vi.fn(),
  gitPanelDiffStats: vi.fn(),
  gitStatus: vi.fn(),
  workspaceKey: "local",
  resumeListeners: new Set<() => void>(),
  changeListeners: new Set<(paths: string[]) => void>(),
}));

vi.mock("@/modules/ai/lib/native", () => ({
  native: {
    gitPanelSnapshot: mocks.gitPanelSnapshot,
    gitPanelDiffStats: mocks.gitPanelDiffStats,
    gitStatus: mocks.gitStatus,
  },
}));
vi.mock("@/modules/workspace", () => ({
  useWorkspaceEnvStore: (
    select: (state: { env: { kind: "local" } }) => unknown,
  ) => select({ env: { kind: "local" } }),
  workspaceScopeKey: () => mocks.workspaceKey,
}));
vi.mock("@/modules/filesystem", () => ({
  subscribeFileSystemChanges: vi.fn(
    (_workspace: unknown, listener: (paths: string[]) => void) => {
      mocks.changeListeners.add(listener);
      return () => mocks.changeListeners.delete(listener);
    },
  ),
  subscribeWorkspaceResume: vi.fn((listener: () => void) => {
    mocks.resumeListeners.add(listener);
    return () => mocks.resumeListeners.delete(listener);
  }),
}));

import {
  type RepositoryController,
  useRepositoryController,
} from "./useRepositoryController";

function repositorySnapshot(repoRoot: string): GitPanelSnapshot {
  const status = {
    repoRoot,
    branch: "main",
    headSha: "head",
    upstream: null,
    ahead: 0,
    behind: 0,
    isDetached: false,
    truncated: false,
    changedFiles: [],
  };
  return {
    repo: {
      repoRoot,
      branch: status.branch,
      upstream: status.upstream,
      isDetached: status.isDetached,
    },
    status,
    graphRevision: "refs-1",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root | null = null;
let controller: RepositoryController | null = null;

beforeEach(() => {
  resetViewCachesForTests();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.workspaceKey = "local";
  mocks.gitPanelDiffStats.mockResolvedValue({ index: null, worktree: null });
});

function Probe({
  contextPath,
  enabled = true,
  foreground = true,
}: {
  contextPath: string | null;
  enabled?: boolean;
  foreground?: boolean;
}) {
  controller = useRepositoryController(contextPath, enabled, foreground);
  return (
    <span>
      {controller.repo?.repoRoot ?? "none"}:{controller.revision}
    </span>
  );
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  controller = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("useRepositoryController", () => {
  it("没有可见消费者时停止读取，切回仓库先显示缓存再校验", async () => {
    vi.useFakeTimers();
    mocks.gitPanelSnapshot.mockImplementation(async (path) =>
      repositorySnapshot(path),
    );
    root = createRoot(document.createElement("div"));
    await act(async () => root?.render(<Probe contextPath="C:/a" />));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    await act(async () => root?.render(<Probe contextPath="C:/b" />));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    await act(async () =>
      root?.render(<Probe contextPath="C:/a" enabled={false} />),
    );
    expect(controller?.repo?.repoRoot).toBe("C:/a");
    expect(controller?.isLoading).toBe(false);
    const count = mocks.gitPanelSnapshot.mock.calls.length;
    expect(mocks.changeListeners.size).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(count);
    await act(async () => root?.render(<Probe contextPath="C:/a" />));
    expect(controller?.repo?.repoRoot).toBe("C:/a");
    expect(controller?.isLoading).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(count + 1);
  });

  it("隐藏后慢快照只进入缓存，不继续统计或待执行补查", async () => {
    vi.useFakeTimers();
    const pending = deferred<GitPanelSnapshot>();
    mocks.gitPanelSnapshot.mockReturnValueOnce(pending.promise);
    root = createRoot(document.createElement("div"));
    await act(async () => root?.render(<Probe contextPath="C:/repo" />));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    await act(async () => {
      void controller?.refresh();
    });
    await act(async () =>
      root?.render(<Probe contextPath="C:/repo" enabled={false} />),
    );
    await act(async () => pending.resolve(repositorySnapshot("C:/repo")));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.gitPanelDiffStats).not.toHaveBeenCalled();
    mocks.gitPanelSnapshot.mockResolvedValue(repositorySnapshot("C:/repo"));
    await act(async () => root?.render(<Probe contextPath="C:/repo" />));
    expect(controller?.repo?.repoRoot).toBe("C:/repo");
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.gitPanelDiffStats).toHaveBeenCalledTimes(1);
  });

  it("rechecks after resuming during an inflight read", async () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    mocks.gitPanelSnapshot.mockResolvedValue(repositorySnapshot("C:/repo"));
    root = createRoot(document.createElement("div"));
    await act(async () => root?.render(<Probe contextPath="C:/repo" />));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    const pending = deferred<GitPanelSnapshot>();
    mocks.gitPanelSnapshot.mockReturnValueOnce(pending.promise);
    // 通过轮询进入慢读取，恢复不能被轮询闭包的运行中状态丢弃。
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    visibility.mockReturnValue("visible");
    await act(async () => {
      for (const listener of mocks.resumeListeners) {
        listener();
        listener();
      }
      pending.resolve(repositorySnapshot("C:/repo"));
    });
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(3);
  });

  it("waits for a foreground snapshot before exposing history when a background read is inflight", async () => {
    vi.useFakeTimers();
    const pending = deferred<GitPanelSnapshot>();
    mocks.gitPanelSnapshot.mockReturnValueOnce(pending.promise);
    root = createRoot(document.createElement("div"));
    await act(async () =>
      root?.render(<Probe contextPath="C:/repo" foreground={false} />),
    );
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(mocks.gitPanelSnapshot).toHaveBeenLastCalledWith("C:/repo", false);
    await act(async () => root?.render(<Probe contextPath="C:/repo" />));
    // 首次读取尚未发布根目录，前台激活仍应追加带引用的快照。
    mocks.gitPanelSnapshot.mockResolvedValue(repositorySnapshot("C:/repo"));
    await act(async () =>
      pending.resolve({
        ...repositorySnapshot("C:/repo"),
        graphRevision: null,
      }),
    );
    expect(controller?.graphRevision).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(controller?.graphRevision).toBe("refs-1");
  });

  it("rechecks a recently hidden window even without file events and merges duplicate resumes", async () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    mocks.gitPanelSnapshot.mockResolvedValue(repositorySnapshot("C:/repo"));
    root = createRoot(document.createElement("div"));
    await act(async () => root?.render(<Probe contextPath="C:/repo" />));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    visibility.mockReturnValue("visible");
    await act(async () => {
      for (const listener of mocks.resumeListeners) {
        listener();
        listener();
      }
    });
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(2);
  });

  it("waits for slow visible statistics before another round", async () => {
    vi.useFakeTimers();
    mocks.gitPanelSnapshot.mockResolvedValue(repositorySnapshot("C:/repo"));
    const stats = deferred<{ index: null; worktree: null }>();
    mocks.gitPanelDiffStats.mockReturnValueOnce(stats.promise);
    root = createRoot(document.createElement("div"));
    await act(async () => root?.render(<Probe contextPath="C:/repo" />));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(controller?.hasRepo).toBe(true);
    expect(mocks.gitPanelDiffStats).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledOnce();
    await act(async () => stats.resolve({ index: null, worktree: null }));
    await act(async () => vi.advanceTimersByTimeAsync(10_599));
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(2);

    await act(async () =>
      root?.render(<Probe contextPath="C:/repo" foreground={false} />),
    );
    const reads = mocks.gitPanelSnapshot.mock.calls.length;
    const statistics = mocks.gitPanelDiffStats.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(4999));
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(reads);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(reads + 1);
    expect(mocks.gitPanelDiffStats).toHaveBeenCalledTimes(statistics);
  });

  it("shares unchanged statistics, updates content with unchanged file status, and discards old-Space statistics", async () => {
    vi.useFakeTimers();
    mocks.gitPanelSnapshot.mockResolvedValue(repositorySnapshot("C:/repo"));
    const statistics = (added: number) => ({
      index: null,
      worktree: { added, removed: 0, incomplete: false, files: {} },
    });
    mocks.gitPanelDiffStats.mockImplementation(async () => statistics(1));
    root = createRoot(document.createElement("div"));
    await act(async () => root?.render(<Probe contextPath="C:/repo" />));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    const initial = controller?.diffStats;
    await act(async () => controller?.refresh());
    expect(controller?.diffStats).toBe(initial);
    mocks.gitPanelDiffStats.mockResolvedValueOnce(statistics(2));
    await act(async () => controller?.refresh());
    expect(controller?.diffStats?.worktree?.added).toBe(2);

    const pending = deferred<ReturnType<typeof statistics>>();
    mocks.gitPanelDiffStats.mockReturnValueOnce(pending.promise);
    let refresh: Promise<void> | undefined;
    await act(async () => {
      refresh = controller?.refresh();
    });
    mocks.gitPanelSnapshot.mockResolvedValue(repositorySnapshot("C:/next"));
    await act(async () => root?.render(<Probe contextPath="C:/next" />));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    await act(async () => {
      pending.resolve(statistics(99));
      await refresh;
    });
    expect(controller?.repo?.repoRoot).toBe("C:/next");
    expect(controller?.diffStats?.worktree?.added).toBe(1);
    mocks.gitPanelSnapshot.mockClear();
    await act(async () => notifyTerminalCommandFinished("C:/repo"));
    expect(mocks.gitPanelSnapshot).not.toHaveBeenCalled();
    await act(async () =>
      root?.render(<Probe contextPath="C:/next" enabled={false} />),
    );
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(mocks.gitPanelSnapshot).not.toHaveBeenCalled();
  });

  it("consumes a debounced invalidation once and defers it if the window hides", async () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    mocks.gitPanelSnapshot.mockImplementation(async () =>
      repositorySnapshot("C:/parent/repo"),
    );
    root = createRoot(document.createElement("div"));
    await act(async () => root?.render(<Probe contextPath="C:/parent/repo" />));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    await act(async () => {
      for (const listener of mocks.resumeListeners) listener();
    });
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledOnce();
    for (const listener of mocks.changeListeners)
      listener(["C:/other/file.ts"]);
    await act(async () => vi.advanceTimersByTimeAsync(120));
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledOnce();
    for (const listener of mocks.changeListeners)
      listener(["C:/parent/repo/file.ts"]);
    visibility.mockReturnValue("hidden");
    await act(async () => vi.advanceTimersByTimeAsync(120));
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue("visible");
    await act(async () => {
      for (const listener of mocks.resumeListeners) listener();
    });
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(2);

    // 父目录批次也可能表示整个仓库被移动；恢复读取后不能再被旧定时器刷新一次。
    for (const listener of mocks.changeListeners) listener(["C:/parent"]);
    await act(async () => {
      for (const listener of mocks.resumeListeners) listener();
    });
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(120));
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(3);
  });

  it("loads a new context independently after an empty result, workspace switch or re-enable", async () => {
    vi.useFakeTimers();
    const empty: GitPanelSnapshot = {
      repo: null,
      status: null,
    };
    mocks.gitPanelSnapshot.mockResolvedValue(empty);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Probe contextPath="C:/empty" />));
    expect(controller?.isLoading).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(controller?.isLoading).toBe(false);

    const previous = deferred<GitPanelSnapshot>();
    const next = deferred<GitPanelSnapshot>();
    mocks.gitPanelSnapshot
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(next.promise);
    let refresh: Promise<void> | undefined;
    await act(async () => {
      refresh = controller?.refresh();
    });
    expect(controller?.isLoading).toBe(false);
    await act(async () => root?.render(<Probe contextPath="C:/next" />));
    expect(controller?.isLoading).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(600));
    await act(async () => previous.resolve(repositorySnapshot("C:/empty")));
    expect(controller?.hasRepo).toBe(false);
    expect(controller?.isLoading).toBe(true);
    expect(mocks.gitPanelSnapshot).toHaveBeenLastCalledWith("C:/next", true);
    await act(async () => {
      next.resolve(empty);
      await refresh;
    });
    expect(controller?.isLoading).toBe(false);

    mocks.workspaceKey = "another-workspace";
    await act(async () => root?.render(<Probe contextPath="C:/next" />));
    expect(controller?.isLoading).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(controller?.isLoading).toBe(false);

    await act(async () =>
      root?.render(<Probe contextPath="C:/next" enabled={false} />),
    );
    expect(controller?.isLoading).toBe(false);
    await act(async () => root?.render(<Probe contextPath="C:/next" />));
    expect(controller?.isLoading).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(controller?.isLoading).toBe(false);
    await act(async () => root?.render(<Probe contextPath={null} />));
    expect(controller?.isLoading).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(600));
    const cleared = controller;
    await act(async () => controller?.refresh());
    expect(controller).toBe(cleared);
  });

  it("retains errors during rechecks and replaces them only when the result changes", async () => {
    vi.useFakeTimers();
    mocks.gitPanelSnapshot.mockRejectedValue("Git unavailable");
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Probe contextPath="C:/project" />));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(controller?.localError).toBe("Git unavailable");
    expect(controller?.isLoading).toBe(false);
    const failed = controller;
    await act(async () => controller?.refresh());
    expect(controller).toBe(failed);

    const pending = deferred<GitPanelSnapshot>();
    mocks.gitPanelSnapshot.mockReturnValueOnce(pending.promise);
    let refresh: Promise<void> | undefined;
    await act(async () => {
      refresh = controller?.refresh();
    });
    expect(controller).toBe(failed);
    await act(async () => {
      pending.resolve({ repo: null, status: null });
      await refresh;
    });
    expect(controller?.localError).toBeNull();
    expect(controller?.isLoading).toBe(false);
  });

  it("polls while unfocused, pauses while hidden and keeps one loop across resumes", async () => {
    vi.useFakeTimers();
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    mocks.gitPanelSnapshot.mockResolvedValue(repositorySnapshot("C:/repo"));
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Probe contextPath="C:/repo" />));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    mocks.gitPanelSnapshot.mockClear();

    focus.mockReturnValue(false);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(1);
    mocks.gitPanelSnapshot.mockClear();

    visibility.mockReturnValue("hidden");
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(mocks.gitPanelSnapshot).not.toHaveBeenCalled();

    const pending = deferred<GitPanelSnapshot>();
    mocks.gitPanelSnapshot.mockReturnValueOnce(pending.promise);
    visibility.mockReturnValue("visible");
    await act(async () => {
      for (const listener of mocks.resumeListeners) listener();
      for (const listener of mocks.resumeListeners) listener();
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(repositorySnapshot("C:/repo")));
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(2);
  });

  it("advances revision after repeated real snapshots with identical status", async () => {
    mocks.gitPanelSnapshot.mockImplementation(async () =>
      repositorySnapshot("C:/repo"),
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<Probe contextPath="C:/repo" />));
    await vi.waitFor(() => expect(container.textContent).toBe("C:/repo:1"));
    const status = controller?.status;
    const repo = controller?.repo;

    await act(async () => {
      await controller?.refresh();
    });

    expect(container.textContent).toBe("C:/repo:2");
    expect(controller?.status).toBe(status);
    expect(controller?.repo).toBe(repo);
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(2);
  });

  it("rediscovers nested repositories and discards the previous path response", async () => {
    const outer = deferred<GitPanelSnapshot>();
    const nested = deferred<GitPanelSnapshot>();
    mocks.gitPanelSnapshot
      .mockReturnValueOnce(outer.promise)
      .mockReturnValueOnce(nested.promise);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<Probe contextPath="C:/outer" />));
    await vi.waitFor(() =>
      expect(mocks.gitPanelSnapshot).toHaveBeenCalledWith("C:/outer", true),
    );
    await act(async () =>
      root?.render(<Probe contextPath="C:/outer/nested" />),
    );
    expect(controller?.isLoading).toBe(true);

    await act(async () => outer.resolve(repositorySnapshot("C:/outer")));
    await vi.waitFor(() =>
      expect(mocks.gitPanelSnapshot).toHaveBeenCalledWith(
        "C:/outer/nested",
        true,
      ),
    );
    expect(container.textContent).not.toContain("C:/outer:");

    await act(async () =>
      nested.resolve(repositorySnapshot("C:/outer/nested")),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toBe("C:/outer/nested:1"),
    );
    expect(mocks.gitStatus).not.toHaveBeenCalled();
    expect(controller?.isLoading).toBe(false);
  });

  it("checks refs in the same snapshot and ignores terminal commands outside the current repository", async () => {
    mocks.gitPanelSnapshot.mockResolvedValue(repositorySnapshot("C:/repo"));
    root = createRoot(document.createElement("div"));
    await act(async () => root?.render(<Probe contextPath="C:/repo" />));
    await vi.waitFor(() => expect(controller?.graphRevision).toBe("refs-1"));
    notifyTerminalCommandFinished("C:/other");
    await act(async () => Promise.resolve());
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledOnce();
    mocks.gitPanelSnapshot.mockResolvedValue({
      ...repositorySnapshot("C:/repo"),
      graphRevision: "refs-2",
    });
    await act(async () =>
      notifyTerminalCommandFinished("C:/repo/packages/app"),
    );
    await vi.waitFor(() => expect(controller?.graphRevision).toBe("refs-2"));
    expect(mocks.gitPanelSnapshot).toHaveBeenLastCalledWith("C:/repo", true);
    mocks.gitPanelSnapshot.mockResolvedValue({
      ...repositorySnapshot("C:/repo"),
      graphRevision: "unavailable",
    });
    await act(async () => controller?.refresh());
    expect(controller?.graphRevision).toBe("refs-2");
  });
});

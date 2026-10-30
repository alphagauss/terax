// @vitest-environment happy-dom
/** 统计不能阻塞清单，快速版本变化只追赶最新批次，隐藏后不发布过期数据。 */
import type { GitPanelDiffStats } from "@/modules/ai/lib/native";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useRepositoryDiffStats } from "./useRepositoryDiffStats";

const io = vi.hoisted(() => ({ stats: vi.fn() }));
vi.mock("@/modules/ai/lib/native", () => ({
  native: { gitPanelDiffStats: io.stats },
}));

it("serializes reads and discards stale versions and repositories", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  io.stats.mockReset();
  const container = document.createElement("div");
  const root = createRoot(container);
  const value = (added: number): GitPanelDiffStats => ({
    index: null,
    worktree: { added, removed: 0, incomplete: false, files: {} },
  });
  let finish!: (stats: GitPanelDiffStats) => void;
  io.stats
    .mockReturnValueOnce(
      new Promise<GitPanelDiffStats>((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue(value(2));
  function View({
    revision,
    active = true,
    repo = "/a",
  }: {
    revision: number;
    active?: boolean;
    repo?: string | null;
  }) {
    const stats = useRepositoryDiffStats(repo, revision, active);
    return <span>{stats?.worktree?.added ?? "pending"}</span>;
  }
  try {
    await act(async () => root.render(<View revision={1} active={false} />));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(io.stats).not.toHaveBeenCalled();
    await act(async () => root.render(<View revision={1} />));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(io.stats).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<View revision={2} />));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    await act(async () => root.render(<View revision={3} repo="/b" />));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(io.stats).toHaveBeenCalledTimes(1);
    await act(async () => finish(value(1)));
    expect(io.stats).toHaveBeenCalledTimes(2);
    expect(io.stats).toHaveBeenLastCalledWith("/b");
    expect(container.textContent).toBe("2");
    await act(async () =>
      root.render(<View revision={4} active={false} repo="/b" />),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(io.stats).toHaveBeenCalledTimes(2);
    await act(async () => root.render(<View revision={4} repo="/b" />));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(io.stats).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("reuses unchanged statistics and removes files that are no longer modified", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  io.stats.mockReset();
  const container = document.createElement("div");
  const root = createRoot(container);
  const initial: GitPanelDiffStats = {
    index: null,
    worktree: {
      added: 1,
      removed: 0,
      incomplete: false,
      files: {
        "a.ts": { added: 1, removed: 0, isBinary: false, incomplete: false },
      },
    },
  };
  io.stats.mockImplementation(async () => structuredClone(initial));
  let latest: GitPanelDiffStats | null = null;
  const renders = vi.fn();
  function View({ revision }: { revision: number }) {
    latest = useRepositoryDiffStats("/repo", revision, true);
    renders();
    return null;
  }
  try {
    await act(async () => root.render(<View revision={1} />));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    const first = latest;
    expect(first).toEqual(initial);
    await act(async () => root.render(<View revision={2} />));
    renders.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(latest).toBe(first);
    expect(renders).not.toHaveBeenCalled();

    const clean: GitPanelDiffStats = {
      index: null,
      worktree: { added: 0, removed: 0, incomplete: false, files: {} },
    };
    io.stats.mockResolvedValueOnce(clean);
    await act(async () => root.render(<View revision={3} />));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(latest).toEqual(clean);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

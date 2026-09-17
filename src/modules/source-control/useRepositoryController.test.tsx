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
  gitGraphRevision: vi.fn(),
  gitStatus: vi.fn(),
  resumeListeners: new Set<() => void>(),
}));

vi.mock("@/modules/ai/lib/native", () => ({
  native: {
    gitPanelSnapshot: mocks.gitPanelSnapshot,
    gitGraphRevision: mocks.gitGraphRevision,
    gitStatus: mocks.gitStatus,
  },
}));
vi.mock("@/modules/workspace", () => ({
  useWorkspaceEnvStore: (
    select: (state: { env: { kind: "local" } }) => unknown,
  ) => select({ env: { kind: "local" } }),
  workspaceScopeKey: () => "local",
}));
vi.mock("@/modules/filesystem", () => ({
  subscribeFileSystemChanges: vi.fn(() => vi.fn()),
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
    diffStats: null,
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
  mocks.gitGraphRevision.mockResolvedValue("refs-1");
});

function Probe({ contextPath }: { contextPath: string }) {
  controller = useRepositoryController(contextPath);
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
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(mocks.gitPanelSnapshot).toHaveBeenCalledTimes(2);
  });

  it("advances revision after repeated real snapshots with identical status", async () => {
    mocks.gitPanelSnapshot.mockResolvedValue(repositorySnapshot("C:/repo"));
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<Probe contextPath="C:/repo" />));
    await vi.waitFor(() => expect(container.textContent).toBe("C:/repo:1"));

    await act(async () => {
      await controller?.refresh();
    });

    expect(container.textContent).toBe("C:/repo:2");
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
      expect(mocks.gitPanelSnapshot).toHaveBeenCalledWith("C:/outer"),
    );
    await act(async () =>
      root?.render(<Probe contextPath="C:/outer/nested" />),
    );

    await act(async () => outer.resolve(repositorySnapshot("C:/outer")));
    await vi.waitFor(() =>
      expect(mocks.gitPanelSnapshot).toHaveBeenCalledWith("C:/outer/nested"),
    );
    expect(container.textContent).not.toContain("C:/outer:");

    await act(async () =>
      nested.resolve(repositorySnapshot("C:/outer/nested")),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toBe("C:/outer/nested:1"),
    );
    expect(mocks.gitStatus).not.toHaveBeenCalled();
  });

  it("only advances graph revision when a command in the repository changes refs", async () => {
    mocks.gitPanelSnapshot.mockResolvedValue(repositorySnapshot("C:/repo"));
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<Probe contextPath="C:/repo" />));
    await vi.waitFor(() =>
      expect(mocks.gitGraphRevision).toHaveBeenCalledOnce(),
    );

    notifyTerminalCommandFinished("C:/other");
    await act(async () => Promise.resolve());
    expect(mocks.gitGraphRevision).toHaveBeenCalledOnce();

    mocks.gitGraphRevision.mockResolvedValue("refs-2");
    notifyTerminalCommandFinished("C:/repo/packages/app");
    await vi.waitFor(() => expect(controller?.graphRevision).toBe("refs-2"));

    notifyTerminalCommandFinished("C:/repo");
    await vi.waitFor(() =>
      expect(mocks.gitGraphRevision).toHaveBeenCalledTimes(3),
    );
    expect(controller?.graphRevision).toBe("refs-2");
  });
});

// @vitest-environment happy-dom

import type { GitBranchEntry, GitPanelSnapshot } from "@/modules/ai/lib/native";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { commitMessageStore, setCommitMessageDraft } from "./commitMessage";
import { SourceControlViewContainer } from "./SourceControlPanel";
import type { RepositoryController } from "./useRepositoryController";
import { useRepositoryController } from "./useRepositoryController";

const io = vi.hoisted(() => ({
  snapshot: vi.fn(),
  stats: vi.fn(async () => ({ index: null, worktree: null })),
  stage: vi.fn(),
  unstage: vi.fn(),
  branches: vi.fn(),
  checkoutBranch: vi.fn(),
  checkoutTag: vi.fn(),
}));
vi.mock("@/modules/ai/lib/native", async (original) => {
  const module = await original<typeof import("@/modules/ai/lib/native")>();
  return {
    ...module,
    native: {
      ...module.native,
      gitPanelSnapshot: io.snapshot,
      gitPanelDiffStats: io.stats,
      gitStage: io.stage,
      gitUnstage: io.unstage,
      gitListBranches: io.branches,
      gitCheckoutBranch: io.checkoutBranch,
      gitCheckoutTag: io.checkoutTag,
    },
  };
});
vi.mock("@/modules/filesystem", async (original) => ({
  ...(await original<typeof import("@/modules/filesystem")>()),
  subscribeFileSystemChanges: () => () => {},
  subscribeWorkspaceResume: () => () => {},
}));

vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@/modules/source-control/GraphSection", () => ({
  GraphSection: ({ repoRoot }: { repoRoot: string | null }) =>
    repoRoot ? <div data-scm-graph={repoRoot} /> : null,
}));
vi.mock("@/modules/explorer/lib/iconResolver", () => ({
  fileIconUrl: () => null,
}));

it("分支浮窗展示四类引用，标签检出刷新仓库，工作树导航到对应目录", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const originalHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  )?.get;
  const measurements = vi
    .spyOn(HTMLElement.prototype, "offsetHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      if (this.matches('[data-slot="dropdown-menu-label"]')) {
        return 36;
      }
      if (this.matches('[role="menuitem"]')) {
        return this.textContent?.includes("/repo-feature") ? 48 : 32;
      }
      return originalHeight?.call(this) ?? 0;
    });
  const branches: GitBranchEntry[] = [
    { name: "main", kind: "local", isHead: true },
    { name: "origin/main", kind: "remote", isHead: false },
    { name: "origin/feature", kind: "remote", isHead: false },
    { name: "main", kind: "tag", isHead: false },
  ].map((entry) => ({
    ...entry,
    kind: entry.kind as GitBranchEntry["kind"],
    worktreePath: null,
    isDetached: false,
    timestampSecs: null,
    tagSources: entry.kind === "tag" ? ["local", "origin"] : [],
  }));
  branches.push({
    name: "feature",
    kind: "worktree",
    worktreePath: "/repo-feature",
    isHead: false,
    isDetached: false,
    timestampSecs: null,
    tagSources: [],
  });
  io.branches.mockResolvedValue({ branches });
  io.checkoutBranch.mockResolvedValue(undefined);
  io.checkoutTag.mockResolvedValue(undefined);
  const controller: RepositoryController = {
    repo: {
      repoRoot: "/repo",
      branch: "main",
      upstream: null,
      isDetached: false,
    },
    status: null,
    changedCount: 0,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRepo: true,
    isLoading: false,
    localError: null,
    busyAction: null,
    lastRemoteError: null,
    remoteOperation: null,
    cancelRemoteAction: vi.fn(),
    revision: 1,
    graphRevision: null,
    diffStats: null,
    refresh: vi.fn(),
    runRemoteAction: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onNavigateToPath = vi.fn();
  const menu = () => document.querySelector('[role="menu"]');
  const openMenu = async () => {
    const trigger = container.querySelector(
      '[data-slot="dropdown-menu-trigger"]',
    );
    if (!trigger) throw new Error("Missing branch trigger");
    await act(async () => {
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
  };
  try {
    await act(async () =>
      root.render(
        <SourceControlViewContainer
          open
          sourceControl={controller}
          onOpenDiff={vi.fn()}
          onNavigateToPath={onNavigateToPath}
        />,
      ),
    );
    await openMenu();
    expect(io.branches).toHaveBeenLastCalledWith("/repo");
    expect(menu()?.textContent).toContain("branch.localBranches");
    expect(menu()?.textContent).toContain("branch.remoteBranches");
    expect(menu()?.textContent).toContain("branch.tags");
    expect(menu()?.textContent).toContain("branch.worktrees");
    const groups = menu()?.querySelectorAll(
      '[data-slot="dropdown-menu-group"]',
    );
    expect(groups).toHaveLength(4);
    // happy-dom 的视觉矩形高度为零，仍须按布局高度容纳首行及工作树路径。
    expect(groups?.[0].parentElement?.style.minHeight).toBe("69px");
    expect(groups?.[3].parentElement?.style.minHeight).toBe("85px");
    const tag = groups?.[2].querySelector<HTMLElement>('[role="menuitem"]');
    expect(tag?.textContent).toContain("main");
    expect(tag?.textContent).toContain("branch.tagSource.local");
    expect(tag?.textContent).toContain("branch.tagSource.origin");
    await act(async () => tag?.click());
    expect(io.checkoutTag).toHaveBeenCalledWith("/repo", "main");
    expect(io.checkoutBranch).not.toHaveBeenCalled();
    expect(controller.refresh).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();

    for (const [name, target, track] of [
      ["origin/main", "main", false],
      ["origin/feature", "origin/feature", true],
    ] as const) {
      await openMenu();
      const item = [
        ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ].find((entry) => entry.textContent === name);
      await act(async () => item?.click());
      expect(io.checkoutBranch).toHaveBeenLastCalledWith(
        "/repo",
        target,
        track,
      );
    }
    await openMenu();
    const worktree = menu()
      ?.querySelectorAll('[data-slot="dropdown-menu-group"]')[3]
      .querySelector<HTMLElement>('[role="menuitem"]');
    expect(worktree?.textContent).toContain("feature");
    expect(worktree?.textContent).toContain("/repo-feature");
    await act(async () => worktree?.click());
    expect(onNavigateToPath).toHaveBeenCalledExactlyOnceWith("/repo-feature");
    expect(io.checkoutBranch).toHaveBeenCalledTimes(2);
    expect(io.checkoutTag).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    io.checkoutBranch.mockClear();
    io.checkoutTag.mockClear();
    measurements.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("keeps all Changes rows and the commit input mounted across switches and supports keyboard navigation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const savedMessages = commitMessageStore.getState();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const controller: RepositoryController = {
    repo: {
      repoRoot: "/repo",
      branch: "main",
      upstream: null,
      isDetached: false,
    },
    status: {
      repoRoot: "/repo",
      branch: "main",
      headSha: "head",
      upstream: null,
      ahead: 0,
      behind: 0,
      isDetached: false,
      truncated: false,
      changedFiles: Array.from({ length: 40 }, (_, index) => ({
        path: index === 0 ? "a.ts" : `file-${index}.ts`,
        originalPath: null,
        indexStatus: "M",
        worktreeStatus: " ",
        staged: true,
        unstaged: false,
        untracked: false,
        statusLabel: "Modified",
      })),
    },
    changedCount: 40,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRepo: true,
    isLoading: false,
    localError: null,
    busyAction: null,
    lastRemoteError: null,
    remoteOperation: null,
    cancelRemoteAction: vi.fn(),
    revision: 1,
    graphRevision: null,
    diffStats: null,
    refresh: vi.fn(),
    runRemoteAction: vi.fn(),
  };
  const onOpenDiff = vi.fn();
  const render = async (open: boolean) => {
    await act(async () => {
      root.render(
        <div style={{ visibility: open ? "visible" : "hidden" }} inert={!open}>
          <SourceControlViewContainer
            open={open}
            sourceControl={controller}
            onOpenDiff={onOpenDiff}
          />
        </div>,
      );
    });
  };
  const getScroll = () =>
    container.querySelector('[role="listbox"] > .app-scrollbar');

  try {
    setCommitMessageDraft("/repo", "unfinished commit");
    await render(true);
    const scroll = getScroll();
    const input = container.querySelector("textarea");
    expect(scroll).not.toBeNull();
    expect(input).not.toBeNull();
    const rows = [...container.querySelectorAll('[role="option"]')];
    expect(rows).toHaveLength(40);
    expect(
      rows.flatMap((row) => [...row.querySelectorAll("button")]),
    ).toHaveLength(40);
    expect(
      container.querySelectorAll('[data-slot="context-menu-trigger"]'),
    ).toHaveLength(1);
    await act(async () =>
      rows[0].dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerType: "mouse",
        }),
      ),
    );
    expect(rows[0].querySelectorAll("button").length).toBeGreaterThan(1);
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(
      rows.flatMap((row) => [...row.querySelectorAll("button")]),
    ).toHaveLength(40);
    input?.setSelectionRange(2, 7);

    // 检查隐藏期间的真实节点，避免仅在恢复后重建相同内容也通过测试。
    for (const open of [false, true]) {
      await render(open);
      expect(getScroll()).toBe(scroll);
      expect(scroll?.isConnected).toBe(true);
      expect(container.querySelector("textarea")).toBe(input);
      expect(input?.value).toBe("unfinished commit");
      expect(input?.selectionStart).toBe(2);
      expect(input?.selectionEnd).toBe(7);
      const current = container.querySelectorAll('[role="option"]');
      expect(current).toHaveLength(rows.length);
      rows.forEach((row, index) => {
        expect(current[index]).toBe(row);
      });
    }
    const list = container.querySelector<HTMLElement>('[role="listbox"]');
    if (!list) throw new Error("Missing Changes list");
    await act(async () => {
      list.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(list.getAttribute("aria-activedescendant")).toBe(rows[0].id);
    await act(async () => {
      list.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(onOpenDiff).toHaveBeenCalledWith(
      expect.objectContaining({ path: "a.ts" }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    commitMessageStore.setState(savedMessages, true);
    vi.unstubAllGlobals();
  }
});

it("万条改动只挂载一页，分页跨分组且批量操作使用完整清单", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const files = Array.from({ length: 10_000 }, (_, index) => ({
    path: `file-${index}.ts`,
    originalPath: null,
    indexStatus: index < 60 ? "M" : " ",
    worktreeStatus: index < 60 ? " " : "M",
    staged: index < 60,
    unstaged: index >= 60,
    untracked: false,
    statusLabel: "Modified",
  }));
  let controller: RepositoryController = {
    repo: {
      repoRoot: "/repo",
      branch: "main",
      upstream: null,
      isDetached: false,
    },
    status: {
      repoRoot: "/repo",
      branch: "main",
      headSha: "head",
      upstream: null,
      ahead: 0,
      behind: 0,
      isDetached: false,
      truncated: false,
      changedFiles: files,
    },
    changedCount: files.length,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRepo: true,
    isLoading: false,
    localError: null,
    busyAction: null,
    lastRemoteError: null,
    remoteOperation: null,
    cancelRemoteAction: vi.fn(),
    revision: 1,
    graphRevision: null,
    diffStats: null,
    refresh: vi.fn(),
    runRemoteAction: vi.fn(),
  };
  const onOpenDiff = vi.fn();
  const render = async (open = true) => {
    await act(async () =>
      root.render(
        <SourceControlViewContainer
          open={open}
          sourceControl={controller}
          onOpenDiff={onOpenDiff}
        />,
      ),
    );
  };
  const rows = () => [
    ...container.querySelectorAll<HTMLElement>('[role="option"]'),
  ];
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find(
      (node) => node.textContent === text,
    );
  const click = async (node: HTMLElement | null | undefined) => {
    if (!node) throw new Error("Missing button");
    await act(async () => node.click());
  };
  const resize = async (count: number) => {
    if (!controller.status) throw new Error("Missing status");
    controller = {
      ...controller,
      changedCount: count,
      status: { ...controller.status, changedFiles: files.slice(0, count) },
    };
    await render();
  };
  try {
    await render();
    expect(rows()).toHaveLength(50);
    expect(container.textContent).toContain("largeChanges");
    expect(button("pagination.previous")?.disabled).toBe(true);
    await click(
      container.querySelector<HTMLElement>('[aria-label="groups.stageAll"]'),
    );
    expect(io.stage).toHaveBeenLastCalledWith(
      "/repo",
      files.slice(60).map((file) => file.path),
    );
    expect(controller.refresh).toHaveBeenCalledOnce();
    await click(
      container.querySelector<HTMLElement>('[aria-label="groups.unstageAll"]'),
    );
    expect(io.unstage).toHaveBeenLastCalledWith(
      "/repo",
      files.slice(0, 60).map((file) => file.path),
    );

    await resize(121);
    expect(container.textContent).not.toContain("largeChanges");
    await click(button("pagination.next"));
    expect(rows()).toHaveLength(50);
    expect(rows()[0].dataset.scmRowKey).toBe("index:file-50.ts");
    expect(rows()[10].dataset.scmRowKey).toBe("worktree:file-60.ts");
    const firstRow = rows()[0];
    await render(false);
    await render(true);
    expect(rows()[0]).toBe(firstRow);
    const list = container.querySelector<HTMLElement>('[role="listbox"]');
    if (!list) throw new Error("Missing Changes list");
    await act(async () => {
      list.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    await act(async () => {
      list.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(onOpenDiff).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "file-50.ts", side: "index" }),
    );
    await click(button("pagination.next"));
    expect(rows()).toHaveLength(21);
    expect(rows()[0].dataset.scmRowKey).toBe("worktree:file-100.ts");
    expect(button("pagination.next")?.disabled).toBe(true);
    expect(list.getAttribute("aria-activedescendant")).toBeNull();
    await click(button("pagination.previous"));
    expect(rows()[0].dataset.scmRowKey).toBe("index:file-50.ts");

    await resize(40);
    expect(rows()).toHaveLength(40);
    expect(rows()[0].dataset.scmRowKey).toBe("index:file-0.ts");
    expect(button("pagination.next")).toBeUndefined();
    await resize(121);
    expect(rows()[0].dataset.scmRowKey).toBe("index:file-0.ts");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    io.stage.mockClear();
    io.unstage.mockClear();
    vi.unstubAllGlobals();
  }
});

it("keeps the no-repository UI stable during polling and discovers repository creation and removal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const empty: GitPanelSnapshot = { repo: null, status: null };
  let complete!: (snapshot: GitPanelSnapshot) => void;
  const pending = () =>
    new Promise<GitPanelSnapshot>((resolve) => {
      complete = resolve;
    });
  io.snapshot.mockImplementation(pending);
  let controller!: RepositoryController;
  function View() {
    controller = useRepositoryController("/project");
    return (
      <SourceControlViewContainer
        open
        sourceControl={controller}
        onOpenDiff={vi.fn()}
      />
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const refreshButton = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="refresh"]');
  const emptyTitle = () =>
    [...container.querySelectorAll("div")].find(
      (element) => element.textContent === "No repository",
    );
  try {
    await act(async () => root.render(<View />));
    expect(container.textContent).toContain("panel.loadingChanges");
    expect(container.textContent).not.toContain("No repository");
    await act(async () => vi.advanceTimersByTimeAsync(600));
    await act(async () => complete(empty));
    const title = emptyTitle();
    const button = refreshButton();
    const icon = button?.firstElementChild;
    const settled = controller;
    expect(title).toBeDefined();
    expect(button?.disabled).toBe(false);

    // 保留真实节点和控制器引用，覆盖请求进行中与相同结果返回后的稳定性。
    for (let cycle = 0; cycle < 2; cycle++) {
      await act(async () => vi.advanceTimersByTimeAsync(3_000));
      expect(io.snapshot).toHaveBeenCalledTimes(cycle + 2);
      expect(controller).toBe(settled);
      expect(emptyTitle()).toBe(title);
      expect(button?.firstElementChild).toBe(icon);
      expect(button?.disabled).toBe(false);
      expect(container.textContent).not.toContain("panel.loadingChanges");
      await act(async () => complete(empty));
      expect(controller).toBe(settled);
      expect(emptyTitle()).toBe(title);
    }

    await act(async () => button?.click());
    expect(emptyTitle()).toBe(title);
    expect(icon?.classList.contains("animate-spin")).toBe(true);
    expect(button?.disabled).toBe(true);
    await act(async () => complete(empty));
    expect(icon?.classList.contains("animate-spin")).toBe(false);
    expect(button?.disabled).toBe(false);

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await act(async () =>
      complete({
        graphRevision: "refs-1",
        repo: {
          repoRoot: "/project",
          branch: "main",
          upstream: null,
          isDetached: false,
        },
        status: {
          repoRoot: "/project",
          branch: "main",
          headSha: "head",
          upstream: null,
          ahead: 0,
          behind: 0,
          isDetached: false,
          truncated: false,
          changedFiles: [],
        },
      }),
    );
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(emptyTitle()).toBeUndefined();
    expect(controller.revision).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(container.querySelector("textarea")).not.toBeNull();
    await act(async () => complete(empty));
    expect(emptyTitle()).toBeDefined();
    expect(container.querySelector("textarea")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    io.snapshot.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("根目录切换立即卸载旧 Graph，同仓库检测完成后重新加载，普通刷新保留实例", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const snapshot: GitPanelSnapshot = {
    graphRevision: "refs-1",
    repo: {
      repoRoot: "/repo",
      branch: "main",
      upstream: null,
      isDetached: false,
    },
    status: {
      repoRoot: "/repo",
      branch: "main",
      headSha: "head",
      upstream: null,
      ahead: 0,
      behind: 0,
      isDetached: false,
      truncated: false,
      changedFiles: [],
    },
  };
  io.snapshot.mockResolvedValue(snapshot);
  let controller!: RepositoryController;
  function View({ path }: { path: string | null }) {
    controller = useRepositoryController(path);
    return (
      <SourceControlViewContainer
        open
        sourceControl={controller}
        onOpenDiff={vi.fn()}
      />
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const graph = () => container.querySelector("[data-scm-graph]");
  try {
    await act(async () => root.render(<View path="/repo/first" />));
    await act(async () => vi.advanceTimersByTimeAsync(600));
    const original = graph();
    expect(original).not.toBeNull();
    const input = container.querySelector("textarea");
    const progress = () => container.querySelector('[role="progressbar"]');
    let finish!: (snapshot: GitPanelSnapshot) => void;
    io.snapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = controller.refresh();
    });
    expect(graph()).toBe(original);
    expect(container.querySelector("textarea")).toBe(input);
    expect(progress()).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(progress()).toBeNull();
    expect(container.textContent).not.toContain("panel.loadingChanges");
    expect(container.querySelector("textarea")).toBe(input);
    await act(async () => root.render(<View path="/repo/second" />));
    expect(graph()).toBeNull();
    expect(original?.isConnected).toBe(false);
    expect(progress()).toBeNull();
    expect(container.textContent).toContain("gitHistory:loadingCommits");
    let load!: (snapshot: GitPanelSnapshot) => void;
    io.snapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        load = resolve;
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(600));
    await act(async () => {
      finish(snapshot);
    });
    expect(graph()).toBeNull();
    expect(io.snapshot).toHaveBeenLastCalledWith("/repo/second", true);
    await act(async () => {
      load(snapshot);
      await refresh;
    });
    expect(graph()).not.toBeNull();
    expect(graph()).not.toBe(original);
    const current = graph();
    const currentInput = container.querySelector("textarea");
    io.snapshot.mockRejectedValueOnce(new Error("changes refresh failed"));
    await act(async () => controller.refresh());
    expect(graph()).toBe(current);
    expect(container.querySelector("textarea")).toBe(currentInput);
    expect(container.textContent).toContain("changes refresh failed");
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "panel.retry",
    );
    await act(async () => retry?.click());
    expect(container.textContent).not.toContain("changes refresh failed");
    await act(async () => controller.refresh());
    expect(graph()).toBe(current);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(progress()).toBeNull();
    await act(async () => root.render(<View path={null} />));
    expect(graph()).toBeNull();
    expect(current?.isConnected).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    io.snapshot.mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("keeps partial staging actions, diffs and tooltips scoped to each group and removes empty groups", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const controller: RepositoryController = {
    repo: {
      repoRoot: "/repo",
      branch: "main",
      upstream: null,
      isDetached: false,
    },
    status: {
      repoRoot: "/repo",
      branch: "main",
      headSha: "head",
      upstream: null,
      ahead: 0,
      behind: 0,
      isDetached: false,
      truncated: false,
      changedFiles: [
        {
          path: "a.ts",
          originalPath: null,
          indexStatus: "M",
          worktreeStatus: "M",
          staged: true,
          unstaged: true,
          untracked: false,
          statusLabel: "Modified",
        },
      ],
    },
    changedCount: 1,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRepo: true,
    isLoading: false,
    localError: null,
    busyAction: null,
    lastRemoteError: null,
    remoteOperation: null,
    cancelRemoteAction: vi.fn(),
    revision: 1,
    graphRevision: null,
    diffStats: null,
    refresh: vi.fn(),
    runRemoteAction: vi.fn(),
  };

  const counts = (added: number) => ({
    added,
    removed: 1,
    incomplete: false,
    isBinary: false,
  });
  controller.diffStats = {
    index: { ...counts(3), files: { "a.ts": counts(3) } },
    worktree: { ...counts(7), files: { "a.ts": counts(7) } },
  };
  const onOpenDiff = vi.fn();
  const onOpenFile = vi.fn();
  const render = () =>
    act(async () =>
      root.render(
        <SourceControlViewContainer
          open
          sourceControl={{ ...controller }}
          onOpenDiff={onOpenDiff}
          onOpenFile={onOpenFile}
        />,
      ),
    );
  const row = (side: string) => document.getElementById(`scm-row-${side}:a.ts`);
  const click = (element: Element | null | undefined) =>
    act(async () => (element as HTMLElement)?.click());
  try {
    await render();
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
    for (const [side, added, labels] of [
      ["index", 3, ["menu.openFile", "menu.unstage"]],
      ["worktree", 7, ["menu.openFile", "menu.discardChanges", "menu.stage"]],
    ] as const) {
      const fileRow = row(side);
      if (!fileRow) throw new Error(`Missing ${side} row`);
      await act(async () =>
        fileRow.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            pointerType: "mouse",
          }),
        ),
      );
      await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
      expect(
        [...fileRow.querySelectorAll("button[aria-label]")].map((button) =>
          button.getAttribute("aria-label"),
        ),
      ).toEqual(labels);
      const opened = onOpenDiff.mock.calls.length;
      await click(fileRow.querySelector("button"));
      await click(fileRow.querySelector("button"));
      expect(onOpenDiff).toHaveBeenCalledTimes(opened + 2);
      expect(controller.refresh).not.toHaveBeenCalled();
      expect(onOpenDiff).toHaveBeenLastCalledWith(
        expect.objectContaining({ path: "a.ts", side }),
      );
      await click(fileRow.querySelector('[aria-label="menu.openFile"]'));
      expect(onOpenFile).toHaveBeenLastCalledWith("/repo/a.ts");
      expect(onOpenDiff).toHaveBeenCalledTimes(opened + 2);
      vi.useFakeTimers();
      await act(async () => {
        fileRow.querySelector("button")?.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            pointerType: "mouse",
          }),
        );
      });
      await act(async () => vi.advanceTimersByTimeAsync(850));
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
        `+${added}`,
      );
      await click(fileRow.querySelector("button"));
      vi.useRealTimers();
    }
    const stagedToggle = container.querySelector<HTMLButtonElement>(
      '[data-scm-group="index"] button[aria-expanded]',
    );
    await click(stagedToggle);
    expect(stagedToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(row("index")).toBeNull();
    expect(row("worktree")).not.toBeNull();
    const list = container.querySelector<HTMLElement>('[role="listbox"]');
    await act(async () =>
      list?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    expect(list?.getAttribute("aria-activedescendant")).toBe(
      "scm-row-worktree:a.ts",
    );
    await render();
    expect(stagedToggle?.getAttribute("aria-expanded")).toBe("false");
    await click(stagedToggle);
    expect(stagedToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(row("index")).not.toBeNull();
    const openedBeforeStaging = onOpenDiff.mock.calls.length;
    await act(async () =>
      row("index")?.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerType: "mouse",
        }),
      ),
    );
    await click(row("index")?.querySelector('[aria-label="menu.unstage"]'));
    expect(io.unstage).toHaveBeenLastCalledWith("/repo", ["a.ts"]);
    await click(row("worktree")?.querySelector('[aria-label="menu.stage"]'));
    expect(io.stage).toHaveBeenLastCalledWith("/repo", ["a.ts"]);
    expect(onOpenDiff).toHaveBeenCalledTimes(openedBeforeStaging);
    await click(container.querySelector('[aria-label="groups.unstageAll"]'));
    expect(io.unstage).toHaveBeenCalledTimes(2);
    await click(container.querySelector('[aria-label="groups.stageAll"]'));
    expect(io.stage).toHaveBeenCalledTimes(2);
    expect(controller.refresh).toHaveBeenCalled();
    if (!controller.status) throw new Error("Missing status");
    controller.status = {
      ...controller.status,
      changedFiles: controller.status.changedFiles.map((file) => ({
        ...file,
        indexStatus: "R",
        originalPath: "old.ts",
      })),
    };
    await render();
    await act(async () =>
      row("index")?.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerType: "mouse",
        }),
      ),
    );
    await click(row("index")?.querySelector('[aria-label="menu.unstage"]'));
    expect(io.unstage).toHaveBeenLastCalledWith("/repo", ["a.ts", "old.ts"]);
    await click(container.querySelector('[aria-label="groups.unstageAll"]'));
    expect(io.unstage).toHaveBeenLastCalledWith("/repo", ["a.ts", "old.ts"]);

    if (!controller.status) throw new Error("Missing status");
    controller.status = {
      ...controller.status,
      changedFiles: controller.status.changedFiles.map((file) => ({
        ...file,
        unstaged: false,
        worktreeStatus: " ",
      })),
    };
    await render();
    expect(container.querySelector('[data-scm-group="worktree"]')).toBeNull();
    expect(row("index")).not.toBeNull();
    expect(row("worktree")).toBeNull();
    controller.status = {
      ...controller.status,
      changedFiles: controller.status.changedFiles.map((file) => ({
        ...file,
        path: "src/a.ts",
        originalPath: null,
        indexStatus: "M",
        worktreeStatus: "D",
        unstaged: true,
      })),
    };
    await render();
    const indexRow = document.getElementById("scm-row-index:src/a.ts");
    const worktreeRow = document.getElementById("scm-row-worktree:src/a.ts");
    expect(indexRow?.lastElementChild?.textContent).toBe("M");
    expect(indexRow?.querySelectorAll(".line-through")).toHaveLength(0);
    expect(worktreeRow?.lastElementChild?.textContent).toBe("D");
    expect(
      [...(worktreeRow?.querySelectorAll(".line-through") ?? [])].map(
        (element) => element.textContent,
      ),
    ).toEqual(["a.ts", "src"]);
    expect(indexRow?.querySelector('[aria-label="menu.openFile"]')).toBeNull();
    expect(
      worktreeRow?.querySelector('[aria-label="menu.openFile"]'),
    ).toBeNull();
    await click(worktreeRow?.querySelector("button"));
    expect(onOpenDiff).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "src/a.ts", side: "worktree" }),
    );
    controller.status = { ...controller.status, changedFiles: [] };
    controller.changedCount = 0;
    await render();
    expect(container.querySelector('[data-scm-group="index"]')).toBeNull();
    expect(container.querySelector('[role="option"]')).toBeNull();
  } finally {
    vi.useRealTimers();
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each(["fetch", "pull", "push"] as const)(
  "%s 复用反馈位置，延迟提供终止并在完成后隐藏",
  async (action) => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const controller: RepositoryController = {
      repo: {
        repoRoot: "/feedback",
        branch: "main",
        upstream: "origin/main",
        isDetached: false,
      },
      status: {
        repoRoot: "/feedback",
        branch: "main",
        headSha: "head",
        upstream: "origin/main",
        ahead: 1,
        behind: 1,
        isDetached: false,
        truncated: false,
        changedFiles: [],
      },
      changedCount: 0,
      upstream: "origin/main",
      ahead: 1,
      behind: 1,
      hasRepo: true,
      isLoading: false,
      localError: null,
      busyAction: action,
      lastRemoteError: null,
      remoteOperation: {
        id: "operation",
        action,
        startedAt: Date.now(),
        phase: "running",
      },
      cancelRemoteAction: vi.fn(async () => {}),
      revision: 1,
      graphRevision: null,
      diffStats: null,
      refresh: vi.fn(),
      runRemoteAction: vi.fn(),
    };
    const render = () =>
      act(async () =>
        root.render(
          <SourceControlViewContainer
            open
            sourceControl={{ ...controller }}
            onOpenDiff={vi.fn()}
            onOpenFile={vi.fn()}
          />,
        ),
      );
    const cancel = () =>
      container.querySelector<HTMLButtonElement>(
        '[aria-label="remote.cancel"]',
      );
    const feedback = () => container.querySelector('[role="status"][title]');
    try {
      await render();
      expect(feedback()?.textContent).toBe(`remote.${action}Running`);
      await act(async () => {
        vi.advanceTimersByTime(2999);
      });
      expect(cancel()).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(cancel()).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(feedback()?.className).toContain("opacity-100");
      await act(async () => cancel()?.click());
      expect(controller.cancelRemoteAction).toHaveBeenCalledOnce();
      controller.remoteOperation = {
        ...controller.remoteOperation!,
        phase: "cancelling",
      };
      await render();
      expect(
        container.querySelector<HTMLButtonElement>(
          '[aria-label="remote.cancelling"]',
        )?.disabled,
      ).toBe(true);
      expect(feedback()?.textContent).toBe("remote.cancelling");
      controller.busyAction = null;
      controller.remoteOperation = {
        ...controller.remoteOperation!,
        phase: "cancelled",
      };
      await render();
      expect(cancel()).toBeNull();
      expect(
        container.querySelector('[aria-label="remote.cancelling"]'),
      ).toBeNull();
      expect(container.querySelectorAll('[role="status"][title]')).toHaveLength(
        1,
      );
      expect(feedback()?.textContent).toBe("remote.cancelled");
      await act(async () => {
        vi.advanceTimersByTime(4000);
      });
      expect(feedback()).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  },
);

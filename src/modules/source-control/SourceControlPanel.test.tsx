// @vitest-environment happy-dom

import type { GitPanelSnapshot } from "@/modules/ai/lib/native";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { commitMessageStore, setCommitMessageDraft } from "./commitMessage";
import { SourceControlViewContainer } from "./SourceControlPanel";
import type { RepositoryController } from "./useRepositoryController";
import { useRepositoryController } from "./useRepositoryController";

const io = vi.hoisted(() => ({
  snapshot: vi.fn(),
  graphRevision: vi.fn(),
  stage: vi.fn(),
  unstage: vi.fn(),
}));
vi.mock("@/modules/ai/lib/native", async (original) => {
  const module = await original<typeof import("@/modules/ai/lib/native")>();
  return {
    ...module,
    native: {
      ...module.native,
      gitPanelSnapshot: io.snapshot,
      gitGraphRevision: io.graphRevision,
      gitStage: io.stage,
      gitUnstage: io.unstage,
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
  GraphSection: () => null,
}));
vi.mock("@/modules/explorer/lib/iconResolver", () => ({
  fileIconUrl: () => null,
}));

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
    diffStats: null,
    changedCount: 40,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRepo: true,
    isLoading: false,
    localError: null,
    busyAction: null,
    lastRemoteError: null,
    revision: 1,
    graphRevision: null,
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

it("keeps the no-repository UI stable during polling and discovers repository creation and removal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const empty: GitPanelSnapshot = { repo: null, status: null, diffStats: null };
  let complete!: (snapshot: GitPanelSnapshot) => void;
  const pending = () =>
    new Promise<GitPanelSnapshot>((resolve) => {
      complete = resolve;
    });
  io.snapshot.mockImplementation(pending);
  io.graphRevision.mockResolvedValue("refs-1");
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
    expect(container.textContent).toContain("Loading repository");
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
      expect(container.textContent).not.toContain("Loading repository");
      await act(async () => complete(empty));
      expect(controller).toBe(settled);
      expect(emptyTitle()).toBe(title);
    }

    await act(async () => button?.click());
    expect(emptyTitle()).toBe(title);
    expect(icon?.classList.contains("animate-spin")).toBe(true);
    await act(async () => complete(empty));
    await act(async () => vi.advanceTimersByTimeAsync(450));
    expect(icon?.classList.contains("animate-spin")).toBe(false);

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await act(async () =>
      complete({
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
        diffStats: null,
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
    io.graphRevision.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    diffStats: null,
    changedCount: 1,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRepo: true,
    isLoading: false,
    localError: null,
    busyAction: null,
    lastRemoteError: null,
    revision: 1,
    graphRevision: null,
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
      expect(
        [...fileRow.querySelectorAll("button[aria-label]")].map((button) =>
          button.getAttribute("aria-label"),
        ),
      ).toEqual(labels);
      const opened = onOpenDiff.mock.calls.length;
      await click(fileRow.querySelector("button"));
      await click(fileRow.querySelector("button"));
      expect(onOpenDiff).toHaveBeenCalledTimes(opened + 2);
      expect(onOpenDiff).toHaveBeenLastCalledWith(
        expect.objectContaining({ path: "a.ts", side }),
      );
      await click(fileRow.querySelector('[aria-label="menu.openFile"]'));
      expect(onOpenFile).toHaveBeenLastCalledWith("/repo/a.ts");
      vi.useFakeTimers();
      await act(async () => {
        fileRow.querySelector("button")?.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            pointerType: "mouse",
          }),
        );
        await vi.advanceTimersByTimeAsync(850);
      });
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
    await click(row("index")?.querySelector('[aria-label="menu.unstage"]'));
    expect(io.unstage).toHaveBeenLastCalledWith("/repo", ["a.ts"]);
    await click(row("worktree")?.querySelector('[aria-label="menu.stage"]'));
    expect(io.stage).toHaveBeenLastCalledWith("/repo", ["a.ts"]);
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
        indexStatus: "M",
        worktreeStatus: "D",
        unstaged: true,
      })),
    };
    await render();
    expect(
      row("index")?.querySelector('[aria-label="menu.openFile"]'),
    ).toBeNull();
    expect(
      row("worktree")?.querySelector('[aria-label="menu.openFile"]'),
    ).toBeNull();
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

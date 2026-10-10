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
}));
vi.mock("@/modules/ai/lib/native", async (original) => {
  const module = await original<typeof import("@/modules/ai/lib/native")>();
  return {
    ...module,
    native: {
      ...module.native,
      gitPanelSnapshot: io.snapshot,
      gitGraphRevision: io.graphRevision,
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

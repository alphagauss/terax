/**
 * 本文件测试工作区 Git diff 的可见性与仓库 revision 加载策略。
 * 锁定相同 revision 不重复读取、隐藏期间延迟刷新，以及后台刷新不卸载现有 diff。
 */

// @vitest-environment happy-dom

import { RepositoryProvider } from "@/modules/source-control/RepositoryContext";
import type { RepositoryController } from "@/modules/source-control/useRepositoryController";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gitDiffContent: vi.fn(),
}));

vi.mock("@/modules/ai/lib/native", () => ({
  native: {
    gitDiffContent: mocks.gitDiffContent,
    gitCommitFileDiff: vi.fn(),
  },
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (
    select: (state: { diffViewMode: "split" }) => unknown,
  ) => select({ diffViewMode: "split" }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("./lib/languageResolver", () => ({
  resolveLanguage: () => Promise.resolve(null),
}));
vi.mock("./lib/extensions", () => ({
  buildSharedExtensions: () => [],
  DEFAULT_INDENT: [],
  FOCUSABLE_READONLY_EXTENSIONS: [],
  languageCompartment: { of: () => [] },
  READONLY_EXTENSIONS: [],
}));
vi.mock("./lib/useEditorThemeExt", () => ({ useEditorThemeExt: () => [] }));
vi.mock("@uiw/react-codemirror", () => ({
  default: ({ value }: { value: string }) => (
    <div data-testid="inline-diff" data-value={value}>
      {value}
    </div>
  ),
}));
vi.mock("./SplitDiffView", () => ({
  SplitDiffView: ({
    original,
    modified,
  }: {
    original: string;
    modified: string;
  }) => (
    <div data-testid="split-diff" data-original={original}>
      {modified}
    </div>
  ),
}));

import { WorkingGitDiffPane } from "./GitDiffPane";

const source = {
  repoRoot: "C:/work",
  path: "src/main.ts",
  side: "worktree" as const,
  originalPath: null,
};

function repositoryController(revision: number): RepositoryController {
  return {
    repo: {
      repoRoot: source.repoRoot,
      branch: "main",
      upstream: null,
      isDetached: false,
    },
    status: null,
    diffStats: null,
    changedCount: 0,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRepo: true,
    isLoading: false,
    localError: null,
    busyAction: null,
    lastRemoteError: null,
    revision,
    graphRevision: null,
    refresh: vi.fn(),
    runRemoteAction: vi.fn(),
  };
}

function diffResult(version: string) {
  return {
    originalContent: `before ${version}`,
    modifiedContent: `after ${version}`,
    isBinary: false,
    fallbackPatch: "",
    truncated: false,
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

function renderPane(revision: number, active: boolean) {
  root?.render(
    <RepositoryProvider controller={repositoryController(revision)}>
      <WorkingGitDiffPane source={source} active={active} />
    </RepositoryProvider>,
  );
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("WorkingGitDiffPane", () => {
  it("deduplicates the same revision and preserves the mounted diff during refresh", async () => {
    mocks.gitDiffContent.mockResolvedValueOnce(diffResult("one"));
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => renderPane(1, true));
    await vi.waitFor(() =>
      expect(container.textContent).toContain("after one"),
    );
    const mountedDiff = container.querySelector('[data-testid="split-diff"]');

    await act(async () => renderPane(1, false));
    await act(async () => renderPane(1, true));
    expect(mocks.gitDiffContent).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="split-diff"]')).toBe(
      mountedDiff,
    );

    const refresh = deferred<ReturnType<typeof diffResult>>();
    mocks.gitDiffContent.mockReturnValueOnce(refresh.promise);
    await act(async () => renderPane(2, true));
    await vi.waitFor(() =>
      expect(mocks.gitDiffContent).toHaveBeenCalledTimes(2),
    );
    expect(container.textContent).toContain("after one");
    expect(container.textContent).not.toContain("diff.loading");
    expect(container.querySelector('[data-testid="split-diff"]')).toBe(
      mountedDiff,
    );

    await act(async () => refresh.resolve(diffResult("two")));
    await vi.waitFor(() =>
      expect(container.textContent).toContain("after two"),
    );
    expect(container.querySelector('[data-testid="split-diff"]')).toBe(
      mountedDiff,
    );

    mocks.gitDiffContent.mockRejectedValueOnce(new Error("refresh failed"));
    await act(async () => renderPane(3, true));
    await vi.waitFor(() =>
      expect(mocks.gitDiffContent).toHaveBeenCalledTimes(3),
    );
    expect(container.textContent).toContain("after two");
    expect(container.querySelector('[data-testid="split-diff"]')).toBe(
      mountedDiff,
    );
  });

  it("defers a hidden revision until the diff becomes visible", async () => {
    mocks.gitDiffContent.mockResolvedValue(diffResult("current"));
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => renderPane(1, true));
    await vi.waitFor(() =>
      expect(mocks.gitDiffContent).toHaveBeenCalledTimes(1),
    );
    await act(async () => renderPane(2, false));
    expect(mocks.gitDiffContent).toHaveBeenCalledTimes(1);

    await act(async () => renderPane(2, true));
    await vi.waitFor(() =>
      expect(mocks.gitDiffContent).toHaveBeenCalledTimes(2),
    );
  });

  it("uses the inline view when either side of a text diff is empty", async () => {
    mocks.gitDiffContent
      .mockResolvedValueOnce({
        ...diffResult("added"),
        originalContent: "",
      })
      .mockResolvedValueOnce({
        ...diffResult("deleted"),
        modifiedContent: "",
      });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => renderPane(1, true));
    await vi.waitFor(() =>
      expect(
        container
          .querySelector('[data-testid="inline-diff"]')
          ?.getAttribute("data-value"),
      ).toBe("after added"),
    );
    expect(container.querySelector('[data-testid="split-diff"]')).toBeNull();

    await act(async () => renderPane(2, true));
    await vi.waitFor(() =>
      expect(
        container
          .querySelector('[data-testid="inline-diff"]')
          ?.getAttribute("data-value"),
      ).toBe(""),
    );
    expect(container.querySelector('[data-testid="split-diff"]')).toBeNull();
  });
});

/**
 * 本文件测试工作区 Git diff 的可见性与仓库 revision 加载策略。
 * 锁定 revision 刷新策略，以及整文件删除时的原始行号和删除标记。
 */

// @vitest-environment happy-dom

import { RepositoryProvider } from "@/modules/source-control/RepositoryContext";
import type { RepositoryController } from "@/modules/source-control/useRepositoryController";
import { EditorView } from "@codemirror/view";
import type { ReactCodeMirrorProps } from "@uiw/react-codemirror";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gitDiffContent: vi.fn(),
  gitCommitFileDiff: vi.fn(),
  realEditor: false,
  diffViewMode: "split" as "split" | "inline",
}));

vi.mock("@/modules/ai/lib/native", () => ({
  native: {
    gitDiffContent: mocks.gitDiffContent,
    gitCommitFileDiff: mocks.gitCommitFileDiff,
  },
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: Object.assign(
    (
      select: (state: {
        diffViewMode: "split" | "inline";
        editorWordWrap: false;
      }) => unknown,
    ) => select({ diffViewMode: mocks.diffViewMode, editorWordWrap: false }),
    {
      getState: () => ({
        diffViewMode: "split",
        editorWordWrap: false,
        shortcuts: {},
      }),
    },
  ),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("./lib/languageResolver", () => ({
  resolveLanguage: () => Promise.resolve(null),
  resolveLanguageSync: () => null,
}));
vi.mock("./lib/extensions", () => ({
  buildSharedExtensions: () => [],
  DEFAULT_INDENT: [],
  FOCUSABLE_READONLY_EXTENSIONS: [],
  languageCompartment: { of: () => [] },
  READONLY_EXTENSIONS: [],
  reconfigureWordWrap: vi.fn(),
  wrapCompartment: { of: () => [], reconfigure: () => [] },
}));
vi.mock("./lib/useEditorThemeExt", () => ({ useEditorThemeExt: () => [] }));
vi.mock("@uiw/react-codemirror", async (importOriginal) => {
  const { default: CodeMirror } =
    await importOriginal<typeof import("@uiw/react-codemirror")>();
  return {
    default: (props: ReactCodeMirrorProps) =>
      mocks.realEditor ? (
        <CodeMirror {...props} />
      ) : (
        <div data-testid="inline-diff" data-value={props.value}>
          {props.value}
        </div>
      ),
  };
});
vi.mock("./SplitDiffView", () => ({
  SplitDiffView: ({
    original,
    modified,
    wordWrap,
  }: {
    original: string;
    modified: string;
    wordWrap: boolean;
  }) => (
    <div
      data-testid="split-diff"
      data-original={original}
      data-word-wrap={wordWrap}
    >
      {modified}
    </div>
  ),
}));

import { CommitGitDiffPane, WorkingGitDiffPane } from "./GitDiffPane";
import { ReadonlyDiff } from "./ReadonlyDiff";

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
    changedCount: 0,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRepo: true,
    isLoading: false,
    isRefreshing: false,
    localError: null,
    busyAction: null,
    lastRemoteError: null,
    revision,
    graphRevision: null,
    diffStats: null,
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
  mocks.realEditor = false;
  mocks.diffViewMode = "split";
  vi.unstubAllGlobals();
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
      ).toBe("before deleted"),
    );
    expect(container.querySelector('[data-testid="split-diff"]')).toBeNull();
  });

  it("temporarily toggles word wrap for the current diff", async () => {
    mocks.gitDiffContent.mockResolvedValue(diffResult("current"));
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => renderPane(1, true));
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-testid="split-diff"]'),
      ).not.toBeNull(),
    );

    const diff = container.querySelector('[data-testid="split-diff"]');
    expect(diff?.getAttribute("data-word-wrap")).toBe("false");
    await act(async () => {
      diff?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          code: "KeyZ",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(diff?.getAttribute("data-word-wrap")).toBe("true");
  });

  it.each(["split", "inline"] as const)(
    "shows original line numbers and body highlighting without change gutters in %s mode",
    async (mode) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      mocks.realEditor = true;
      mocks.diffViewMode = mode;
      const original = "first\n\nthird\n";
      mocks.gitDiffContent.mockResolvedValue({
        ...diffResult("deleted"),
        originalContent: original,
        modifiedContent: "",
      });
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);

      await act(async () => renderPane(1, true));
      await vi.waitFor(() => {
        const editor = container.querySelector<HTMLElement>(".cm-editor");
        if (!editor) throw new Error("missing editor");
        expect(EditorView.findFromDOM(editor)?.state.doc.toString()).toBe(
          original,
        );
      });
      const editor = container.querySelector<HTMLElement>(".cm-editor");
      expect(editor?.classList.contains("cm-merge-a")).toBe(true);
      expect(
        [
          ...container.querySelectorAll<HTMLElement>(
            ".cm-lineNumbers .cm-gutterElement",
          ),
        ]
          .filter((element) => element.style.visibility !== "hidden")
          .map((element) => element.textContent),
      ).toEqual(["1", "2", "3", "4"]);
      expect(container.querySelectorAll(".cm-changedLine")).toHaveLength(4);
      expect(container.querySelector(".cm-changeGutter")).toBeNull();
      expect(container.querySelectorAll(".cm-changedText")).toHaveLength(2);
      expect(container.querySelector('[data-testid="split-diff"]')).toBeNull();

      if (!editor) throw new Error("missing editor");
      const view = EditorView.findFromDOM(editor);
      if (!view) throw new Error("missing editor view");
      Object.defineProperties(view.scrollDOM, {
        scrollHeight: { value: 200 },
        clientHeight: { value: 100 },
      });
      mocks.gitDiffContent.mockResolvedValue({
        ...diffResult("deleted"),
        originalContent: "updated\ncontent",
        modifiedContent: "",
      });
      await act(async () => renderPane(2, true));
      await vi.waitFor(() =>
        expect(view.state.doc.toString()).toBe("updated\ncontent"),
      );
      expect(container.querySelector(".cm-editor")).toBe(editor);
      expect(container.querySelector(".cm-changeGutter")).toBeNull();
      expect(
        container.querySelector(".cm-changeOverview-deleted"),
      ).not.toBeNull();
      expect(container.querySelector(".cm-changeOverview-added")).toBeNull();

      mocks.gitDiffContent.mockResolvedValue({
        ...diffResult("restored"),
        originalContent: "",
        modifiedContent: "restored\nfile",
      });
      await act(async () => renderPane(3, true));
      await vi.waitFor(() =>
        expect(view.state.doc.toString()).toBe("restored\nfile"),
      );
      expect(editor.classList.contains("cm-merge-a")).toBe(false);
      expect(editor.classList.contains("cm-merge-b")).toBe(true);
      expect(container.querySelectorAll(".cm-changeOverview")).toHaveLength(1);
      expect(container.querySelector(".cm-changeOverview-deleted")).toBeNull();
      expect(
        container.querySelector(".cm-changeOverview-added"),
      ).not.toBeNull();
    },
  );
});

it.each(["commit", "readonly"] as const)(
  "%s 统一 Diff 的删除内容显示原始行号",
  async (kind) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.realEditor = true;
    mocks.diffViewMode = "inline";
    const originalContent = "old first\nold second\nold third";
    const modifiedContent = "replacement";
    const result = {
      ...diffResult("history"),
      originalContent,
      modifiedContent,
    };
    mocks.gitDiffContent.mockResolvedValue(result);
    mocks.gitCommitFileDiff.mockResolvedValue(result);
    const container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    await act(async () => {
      root?.render(
        kind === "commit" ? (
          <CommitGitDiffPane
            source={{
              repoRoot: source.repoRoot,
              sha: "commit",
              path: source.path,
              originalPath: null,
            }}
          />
        ) : (
          <ReadonlyDiff
            path={source.path}
            before={originalContent}
            after={modifiedContent}
          />
        ),
      );
    });
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".cm-deletedLineNumber")).toHaveLength(
        3,
      ),
    );
    expect(
      [...container.querySelectorAll(".cm-deletedLineNumber")].map(
        (line) => line.textContent,
      ),
    ).toEqual(["1", "2", "3"]);
    expect(container.querySelector(".cm-changeGutter")).toBeNull();
    const editor = container.querySelector<HTMLElement>(".cm-editor");
    expect(editor && EditorView.findFromDOM(editor)?.state.doc.toString()).toBe(
      modifiedContent,
    );
  },
);

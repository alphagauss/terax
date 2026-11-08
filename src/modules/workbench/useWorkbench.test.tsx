/**
 * 本文件测试 Workbench 的标签复用与批量关闭行为。
 */

// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { assertWorkbenchState, groupIds } from "./model";
import { useWorkbench } from "./useWorkbench";

let root: Root | null = null;
let workbench: ReturnType<typeof useWorkbench> | null = null;

function Harness() {
  workbench = useWorkbench();
  return null;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  workbench = null;
  document.body.replaceChildren();
});

it("closes tabs across split groups and Spaces while keeping the active Space", () => {
  root = createRoot(document.createElement("div"));
  act(() => root?.render(createElement(Harness)));
  act(() => {
    const current = workbench;
    if (!current) return;
    current.createSpace("project");
    const first = current.newTabInSpace("project");
    current.splitTab(first, "right");
    current.newTabInSpace("default");
  });

  expect(workbench?.tabs).toHaveLength(3);
  expect(
    workbench && groupIds(workbench.state.spaces.project.root),
  ).toHaveLength(2);
  act(() => workbench?.closeTabs(workbench.getTabs().map((tab) => tab.id)));

  expect(workbench?.tabs).toEqual([]);
  expect(workbench?.activeId).toBe(0);
  expect(Object.keys(workbench?.state.spaces ?? {})).toEqual([
    "default",
    "project",
  ]);
  if (workbench) assertWorkbenchState(workbench.state);
  act(() => workbench?.newTab());
  expect(workbench?.tabs[0].spaceId).toBe("project");
});

describe("useWorkbench Git diff previews", () => {
  it("replaces the temporary diff until the tab is pinned", () => {
    root = createRoot(document.createElement("div"));
    act(() => root?.render(createElement(Harness)));

    act(() => {
      workbench?.openGitDiffTab({
        path: "first.ts",
        repoRoot: "/work",
        side: "worktree",
      });
    });
    expect(workbench?.tabs).toHaveLength(1);
    expect(workbench?.tabs[0]).toMatchObject({
      kind: "git-diff",
      path: "first.ts",
      preview: true,
    });

    act(() => {
      workbench?.openGitDiffTab({
        path: "second.ts",
        repoRoot: "/work",
        side: "worktree",
      });
    });
    expect(workbench?.tabs).toHaveLength(1);
    expect(workbench?.tabs[0]).toMatchObject({
      kind: "git-diff",
      path: "second.ts",
      preview: true,
    });

    act(() => workbench?.pinTab(workbench.tabs[0].id));
    act(() => {
      workbench?.openGitDiffTab({
        path: "third.ts",
        repoRoot: "/work",
        side: "index",
      });
    });
    expect(workbench?.tabs).toHaveLength(2);
    expect(workbench?.tabs).toMatchObject([
      { title: "second.ts (W)", preview: false },
      { title: "third.ts (I)", preview: true },
    ]);
  });

  it("uses the temporary preview slot for commit file diffs", () => {
    root = createRoot(document.createElement("div"));
    act(() => root?.render(createElement(Harness)));

    act(() => {
      workbench?.openGitDiffTab({
        path: "working.ts",
        repoRoot: "/work",
        side: "worktree",
      });
    });
    act(() => {
      workbench?.openCommitFileDiffTab({
        repoRoot: "/work",
        sha: "first-full-sha",
        shortSha: "first",
        subject: "First commit",
        path: "history.ts",
        originalPath: null,
      });
    });

    expect(workbench?.tabs).toMatchObject([
      {
        kind: "git-commit-file",
        path: "history.ts",
        preview: true,
      },
    ]);

    act(() => workbench?.pinTab(workbench.tabs[0].id));
    act(() => {
      workbench?.openCommitFileDiffTab({
        repoRoot: "/work",
        sha: "second-full-sha",
        shortSha: "second",
        subject: "Second commit",
        path: "next.ts",
        originalPath: null,
      });
    });

    expect(workbench?.tabs).toMatchObject([
      { title: "history.ts @ first", preview: false },
      { title: "next.ts @ second", preview: true },
    ]);
  });
});

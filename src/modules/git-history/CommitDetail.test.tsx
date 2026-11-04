// @vitest-environment happy-dom

import type { GitCommitFileChange, GitLogEntry } from "@/modules/ai/lib/native";
import {
  CommitDetail,
  type CommitDetailFilesEntry,
} from "@/modules/git-history/CommitDetail";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/modules/explorer/lib/iconResolver", () => ({
  fileIconUrl: () => null,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
    i18n: { language: "en" },
  }),
}));

const commit: GitLogEntry = {
  sha: "merge",
  shortSha: "merge",
  subject: "Merge feature",
  author: "Author",
  authorEmail: "",
  timestampSecs: 1,
  parents: ["main", "feature"],
  refs: [],
};
const files: GitCommitFileChange[] = [
  {
    path: "new.ts",
    originalPath: "old.ts",
    status: "R",
    statusLabel: "Renamed",
    added: 3,
    removed: 1,
    isBinary: false,
  },
  {
    path: "deleted.ts",
    originalPath: null,
    status: "D",
    statusLabel: "Deleted",
    added: 0,
    removed: 4,
    isBinary: false,
  },
  {
    path: "image.png",
    originalPath: null,
    status: "A",
    statusLabel: "Added",
    added: 0,
    removed: 0,
    isBinary: true,
  },
];
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (filesEntry: CommitDetailFilesEntry | null, entry = commit) =>
  act(async () =>
    root.render(
      <CommitDetail
        commit={entry}
        filesEntry={filesEntry}
        onOpenFile={vi.fn()}
        onRetry={vi.fn()}
      />,
    ),
  );

it("合并提交汇总使用已加载的文件，重命名与二进制各计一个文件", async () => {
  await render({ state: "loaded", files, message: "" });
  expect(container.textContent).toContain("filesChanged:3");
  expect(container.textContent).toContain("insertions:3");
  expect(container.textContent).toContain("deletions:5");
  expect(container.textContent).toContain("relativeToFirstParent");
  expect(container.textContent).not.toContain("filesChanged:0");
});

it("加载和失败期间不显示零变更，重试完成后才展示统计", async () => {
  for (const entry of [null, { state: "loading" }] as const) {
    await render(entry);
    expect(container.textContent).toContain("loadingFiles");
    expect(container.textContent).not.toContain("filesChanged");
  }
  await render({ state: "error", error: "Failed to load files" });
  expect(container.textContent).toContain("Failed to load files");
  expect(container.textContent).not.toContain("filesChanged");
  await render({ state: "loaded", files, message: "" });
  expect(container.textContent).toContain("filesChanged:3");
});

it("真实空合并同时显示零变更和空列表", async () => {
  await render({ state: "loaded", files: [], message: "" });
  expect(container.textContent).toContain("filesChanged:0");
  expect(container.textContent).toContain("noFileChanges");
  expect(container.textContent).not.toContain("insertions:");
  expect(container.textContent).not.toContain("deletions:");
});

it("普通提交也使用文件汇总且不显示合并基准提示", async () => {
  await render(
    { state: "loaded", files, message: "" },
    {
      ...commit,
      parents: ["main"],
    },
  );
  expect(container.textContent).toContain("filesChanged:3");
  expect(container.textContent).not.toContain("relativeToFirstParent");
});

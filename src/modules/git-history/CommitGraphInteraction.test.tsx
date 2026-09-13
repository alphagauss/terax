// @vitest-environment happy-dom

import {
  type GitCommitFileChange,
  type GitLogEntry,
  native,
} from "@/modules/ai/lib/native";
import { GitHistoryPane } from "@/modules/git-history/GitHistoryPane";
import { GraphSection } from "@/modules/source-control/GraphSection";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/modules/ai/lib/native", () => ({
  native: {
    gitLog: vi.fn(),
    gitCommitFiles: vi.fn(),
    gitCommitMessage: vi.fn(),
    gitRemoteUrl: vi.fn(),
  },
}));
vi.mock("@/modules/explorer/lib/iconResolver", () => ({
  fileIconUrl: () => null,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number;
    estimateSize: () => number;
    getItemKey: (index: number) => string;
  }) => ({
    getTotalSize: () => options.count * options.estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: options.getItemKey(index),
        start: index * options.estimateSize(),
        size: options.estimateSize(),
      })),
  }),
}));

const commit = (sha: string, parents: string[]): GitLogEntry => ({
  sha,
  shortSha: sha,
  subject: `Commit ${sha}`,
  author: "Author",
  authorEmail: "author@example.com",
  timestampSecs: 1,
  parents,
  refs: [],
  filesChanged: 1,
  insertions: 12,
  deletions: 3,
});
const files: GitCommitFileChange[] = [
  {
    path: "src/new.ts",
    originalPath: "src/old.ts",
    status: "R",
    statusLabel: "Renamed",
    added: 12,
    removed: 3,
    isBinary: false,
  },
];
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(native.gitLog).mockResolvedValue([
    commit("a", ["b", "c"]),
    commit("b", ["c"]),
  ]);
  vi.mocked(native.gitCommitFiles).mockReset().mockResolvedValue(files);
  vi.mocked(native.gitCommitMessage).mockResolvedValue("Full message");
  vi.mocked(native.gitRemoteUrl).mockResolvedValue("");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});
const wait = async (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

it("侧边栏重复挂载检查仍能完成加载，折叠分组后保留提交展开状态", async () => {
  const render = (expanded: boolean) =>
    root.render(
      <StrictMode>
        <GraphSection
          repoRoot="/repo"
          headSha="a"
          expanded={expanded}
          refreshToken={0}
          showUndoCommit={false}
          mayHavePushedHead={false}
          onDidUndo={() => {}}
        />
      </StrictMode>,
    );
  await act(async () => render(true));
  const row = container.querySelector<HTMLButtonElement>(
    "button[aria-expanded]",
  );
  if (!row) throw new Error("Missing commit row");
  await act(async () => row.click());
  await act(async () => render(false));
  await act(async () => render(true));
  expect(
    container
      .querySelector("button[aria-expanded]")
      ?.getAttribute("aria-expanded"),
  ).toBe("true");
  expect(native.gitCommitFiles).toHaveBeenCalledTimes(1);
});

it.each(["sidebar", "full"])(
  "%s：悬停完整详情与展开精简文件共享内容和 Diff 入口",
  async (mode) => {
    const open = vi.fn();
    await act(async () =>
      root.render(
        mode === "sidebar" ? (
          <GraphSection
            repoRoot="/repo"
            headSha="a"
            expanded
            refreshToken={0}
            showUndoCommit={false}
            mayHavePushedHead={false}
            onDidUndo={() => {}}
            onOpenCommitFile={open}
          />
        ) : (
          <GitHistoryPane repoRoot="/repo" visible onOpenCommitFile={open} />
        ),
      ),
    );
    const rows = () => [
      ...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
    ];
    await act(async () =>
      rows()[0].dispatchEvent(
        new PointerEvent("pointerover", {
          bubbles: true,
          pointerType: "mouse",
        }),
      ),
    );
    await wait(799);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await wait(1);
    const panel = document.querySelector('[role="dialog"]');
    expect(panel?.textContent).toContain("Full message");
    expect(panel?.textContent).toContain("+12");
    expect(panel?.textContent).toContain("−3");
    if (!panel) throw new Error("Missing commit details");
    const floatingFile = [...panel.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("new.ts"),
    );
    if (!floatingFile) throw new Error("Missing file in details");
    await act(async () => floatingFile.click());
    expect(open).toHaveBeenLastCalledWith({
      repoRoot: "/repo",
      sha: "a",
      shortSha: "a",
      subject: "Commit a",
      path: "src/new.ts",
      originalPath: "src/old.ts",
    });
    await act(async () => {
      rows()[0].click();
      rows()[1].click();
    });
    expect(rows().map((row) => row.getAttribute("aria-expanded"))).toEqual([
      "true",
      "true",
    ]);
    const expandedFiles = [...container.querySelectorAll("button")].filter(
      (button) => button.textContent?.includes("new.ts"),
    );
    expect(expandedFiles).toHaveLength(2);
    expect(expandedFiles[0].textContent).toContain("src/old.ts → src/new.ts");
    expect(expandedFiles[0].textContent).toContain("R");
    expect(expandedFiles[0].textContent).not.toContain("+12");
    expect(expandedFiles[0].textContent).not.toContain("−3");
    await act(async () => expandedFiles[0].click());
    expect(open.mock.calls[1]).toEqual(open.mock.calls[0]);
    expect(native.gitCommitFiles).toHaveBeenCalledTimes(2);
    // 合并提交展开区域延续两个底部轨道，且不重复绘制节点。
    const continuation =
      expandedFiles[0].parentElement?.parentElement?.querySelector("svg");
    expect(continuation?.querySelectorAll("line")).toHaveLength(2);
    expect(continuation?.querySelector("circle")).toBeNull();
    await act(async () => rows()[0].click());
    expect(rows().map((row) => row.getAttribute("aria-expanded"))).toEqual([
      "false",
      "true",
    ]);
  },
);

it("键盘可展开文件、进入悬停详情，并用 Esc 返回提交行", async () => {
  await act(async () =>
    root.render(
      <GitHistoryPane repoRoot="/repo" visible onOpenCommitFile={() => {}} />,
    ),
  );
  const row = container.querySelector<HTMLButtonElement>(
    "button[aria-expanded]",
  );
  if (!row) throw new Error("Missing commit row");
  await act(async () => {
    row.focus();
    row.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  });
  expect(row.getAttribute("aria-expanded")).toBe("true");
  await act(async () =>
    row.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F2", bubbles: true }),
    ),
  );
  await wait(1);
  const panel = document.querySelector('[role="dialog"]');
  expect(panel?.contains(document.activeElement)).toBe(true);
  await act(async () =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(document.activeElement).toBe(row);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

// @vitest-environment happy-dom

import { native, type GitFileHistoryEntry } from "@/modules/ai/lib/native";
import { FileTimeline } from "@/modules/git-history/FileTimeline";
import { openUrl } from "@tauri-apps/plugin-opener";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/modules/ai/lib/native", () => ({
  native: {
    gitFileHistory: vi.fn(),
    gitCommitFiles: vi.fn(),
    gitCommitMessage: vi.fn(),
    gitRemoteUrl: vi.fn(),
  },
}));
vi.mock("@/modules/explorer/lib/iconResolver", () => ({
  fileIconUrl: () => null,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
    i18n: { language: "en" },
  }),
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
      })),
  }),
}));

const entry = (sha: string): GitFileHistoryEntry => ({
  sha,
  shortSha: sha,
  subject: `Commit ${sha}`,
  author: "Author",
  authorEmail: "author@example.com",
  timestampSecs: 1,
  parents: [],
  refs: [],
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  path: "src/old.ts",
  originalPath: "src/older.ts",
});
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const props = {
  repoRoot: "/repo",
  headSha: "head",
  path: "/repo/file.ts",
  enabled: true,
  present: true,
  refreshToken: 0,
};
const render = (overrides: Partial<ComponentProps<typeof FileTimeline>> = {}) =>
  act(async () => root.render(<FileTimeline {...props} {...overrides} />));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function scrollToBottom() {
  const scroll = container.querySelector<HTMLElement>(
    '[aria-label="timeline.title"]',
  );
  if (!scroll) throw new Error("缺少时间线视口");
  Object.defineProperty(scroll, "scrollHeight", {
    value: 4000,
    configurable: true,
  });
  Object.defineProperty(scroll, "clientHeight", {
    value: 200,
    configurable: true,
  });
  scroll.scrollTop = 3800;
  scroll.dispatchEvent(new Event("scroll"));
  return scroll;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.mocked(native.gitFileHistory)
    .mockReset()
    .mockResolvedValue([entry("a")]);
  vi.mocked(native.gitCommitFiles)
    .mockReset()
    .mockResolvedValue([
      {
        path: "src/old.ts",
        originalPath: "src/older.ts",
        status: "R",
        statusLabel: "Renamed",
        added: 12,
        removed: 3,
        isBinary: false,
      },
    ]);
  vi.mocked(native.gitCommitMessage)
    .mockReset()
    .mockResolvedValue("Commit a\n\nFull body");
  vi.mocked(native.gitRemoteUrl)
    .mockReset()
    .mockResolvedValue("git@github.com:owner/repo.git");
  vi.mocked(openUrl).mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("隐藏、折叠、无仓库、无选中文件和空 HEAD 均不读取 Git 历史", async () => {
  await render({ enabled: false, present: false });
  await render({ enabled: false });
  await render({ repoRoot: null });
  expect(container.textContent).toContain("timeline.noRepository");
  await render({ path: null });
  expect(container.textContent).toContain("timeline.selectFile");
  await render({ headSha: null });
  expect(container.textContent).toContain("timeline.noHistory");
  expect(native.gitFileHistory).not.toHaveBeenCalled();
  await render();
  expect(native.gitFileHistory).toHaveBeenCalledOnce();
});

it("触底分页合并并发请求，失败可重试，点击记录使用历史路径打开 Diff", async () => {
  const page = Array.from({ length: 40 }, (_, index) =>
    entry(`first-${index}`),
  );
  const more = deferred<GitFileHistoryEntry[]>();
  vi.mocked(native.gitFileHistory)
    .mockResolvedValueOnce(page)
    .mockRejectedValueOnce(new Error("read failed"))
    .mockReturnValueOnce(more.promise);
  const open = vi.fn();
  await render({ onOpenCommitFile: open });
  await act(async () => {
    scrollToBottom();
    scrollToBottom();
  });
  expect(native.gitFileHistory).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("read failed");
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "retry",
  );
  await act(async () => retry?.click());
  await act(async () => {
    scrollToBottom();
    scrollToBottom();
  });
  expect(native.gitFileHistory).toHaveBeenCalledTimes(3);
  expect(native.gitFileHistory).toHaveBeenLastCalledWith(
    "/repo",
    "/repo/file.ts",
    "head",
    { limit: 40, skip: 40 },
  );
  await act(async () => more.resolve([entry("older")]));
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="older Commit older"]')
      ?.click(),
  );
  expect(open).toHaveBeenCalledWith({
    repoRoot: "/repo",
    sha: "older",
    shortSha: "older",
    subject: "Commit older",
    path: "src/old.ts",
    originalPath: "src/older.ts",
  });
  await act(async () => scrollToBottom());
  expect(native.gitFileHistory).toHaveBeenCalledTimes(3);
});

it("快速切换文件和 HEAD 后，迟到的上一文件分页不能覆盖新历史", async () => {
  const more = deferred<GitFileHistoryEntry[]>();
  vi.mocked(native.gitFileHistory)
    .mockResolvedValueOnce(
      Array.from({ length: 40 }, (_, index) => entry(`old-${index}`)),
    )
    .mockReturnValueOnce(more.promise)
    .mockResolvedValueOnce([entry("new-file")])
    .mockResolvedValueOnce([entry("new-head")]);
  await render();
  await act(async () => scrollToBottom());
  await render({ path: "/repo/next.ts" });
  expect(container.textContent).toContain("Commit new-file");
  expect(container.textContent).not.toContain("Commit old-0");
  await act(async () => more.resolve([entry("late")]));
  expect(container.textContent).not.toContain("Commit late");
  await render({ path: "/repo/next.ts", headSha: "next-head" });
  expect(container.textContent).toContain("Commit new-head");
  expect(native.gitFileHistory).toHaveBeenLastCalledWith(
    "/repo",
    "/repo/next.ts",
    "next-head",
    { limit: 40 },
  );
});

it("折叠释放展示后复用缓存和滚动位置，仅手动刷新或 HEAD 变化重新读取", async () => {
  vi.mocked(native.gitFileHistory).mockResolvedValue(
    Array.from({ length: 40 }, (_, index) => entry(`${index}`)),
  );
  await render();
  const scroll = container.querySelector<HTMLElement>(
    '[aria-label="timeline.title"]',
  );
  if (!scroll) throw new Error("缺少时间线视口");
  await act(async () => {
    scroll.scrollTop = 84;
    scroll.dispatchEvent(new Event("scroll"));
  });
  const calls = vi.mocked(native.gitFileHistory).mock.calls.length;
  await render({ enabled: false, present: false });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(container.childElementCount).toBe(0);
  await render();
  expect(
    container.querySelector<HTMLElement>('[aria-label="timeline.title"]')
      ?.scrollTop,
  ).toBe(84);
  expect(native.gitFileHistory).toHaveBeenCalledTimes(calls);
  await render({ refreshToken: 1 });
  expect(native.gitFileHistory).toHaveBeenCalledTimes(calls + 1);
});

it("初次查询失败后可以重试，切换文件时不会显示迟到的初次查询", async () => {
  const initial = deferred<GitFileHistoryEntry[]>();
  vi.mocked(native.gitFileHistory)
    .mockReturnValueOnce(initial.promise)
    .mockRejectedValueOnce({ message: "initial failed" })
    .mockResolvedValueOnce([]);
  await render();
  await render({ path: "/repo/next.ts" });
  await act(async () => initial.resolve([entry("late")]));
  expect(container.textContent).toContain("initial failed");
  expect(container.textContent).not.toContain("Commit late");
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "retry",
  );
  await act(async () => retry?.click());
  expect(container.textContent).toContain("timeline.noHistory");
});

it("时间线沿用 Git 历史详情的延迟、文件缓存和远端入口，列表不显示作者", async () => {
  const open = vi.fn();
  await render({ onOpenCommitFile: open });
  const row = container.querySelector<HTMLButtonElement>(
    '[aria-label="a Commit a"]',
  );
  if (!row) throw new Error("缺少时间线记录");
  expect(row.textContent).not.toContain("Author");
  expect(native.gitCommitFiles).not.toHaveBeenCalled();
  expect(native.gitCommitMessage).not.toHaveBeenCalled();
  await act(async () =>
    row.dispatchEvent(
      new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }),
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(799);
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  const panel = document.querySelector('[role="dialog"]');
  expect(panel?.textContent).toContain("Full body");
  expect(panel?.textContent).toContain("Author");
  expect(panel?.textContent).toContain("copySha");
  expect(panel?.textContent).toContain("filesChanged:1");
  expect(panel?.textContent).toContain("insertions:12");
  expect(panel?.textContent).toContain("deletions:3");
  const remote = [...(panel?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "viewOn",
  );
  await act(async () => remote?.click());
  expect(openUrl).toHaveBeenLastCalledWith(
    "https://github.com/owner/repo/commit/a",
  );
  const file = [...(panel?.querySelectorAll("button") ?? [])].find((button) =>
    button.textContent?.includes("old.ts"),
  );
  await act(async () => file?.click());
  expect(open).toHaveBeenCalledWith({
    repoRoot: "/repo",
    sha: "a",
    shortSha: "a",
    subject: "Commit a",
    path: "src/old.ts",
    originalPath: "src/older.ts",
  });
  await act(async () =>
    row.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F2", bubbles: true }),
    ),
  );
  expect(native.gitCommitFiles).toHaveBeenCalledTimes(1);
  expect(native.gitCommitMessage).toHaveBeenCalledTimes(1);
  expect(
    document.querySelector('[role="dialog"]')?.contains(document.activeElement),
  ).toBe(true);
  await render({ enabled: false, present: false });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

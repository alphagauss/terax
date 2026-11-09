import { resetViewCachesForTests } from "@/modules/view-state/cache";
// @vitest-environment happy-dom

import {
  type GitCommitFileChange,
  type GitLogEntry,
  native,
} from "@/modules/ai/lib/native";
import { clearErrors, errorStore } from "@/lib/errors";
import { GraphSection } from "@/modules/source-control/GraphSection";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const virtualRange = vi.hoisted(() => ({ limit: Number.POSITIVE_INFINITY }));

vi.mock("@/modules/ai/lib/native", () => ({
  native: {
    gitLog: vi.fn(),
    gitCommitFiles: vi.fn(),
    gitCommitMessage: vi.fn(),
    gitRemoteUrl: vi.fn(),
  },
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(),
}));
vi.mock("@/modules/explorer/lib/iconResolver", () => ({
  fileIconUrl: () => null,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
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
      Array.from(
        { length: Math.min(options.count, virtualRange.limit) },
        (_, index) => ({
          index,
          key: options.getItemKey(index),
          start: index * options.estimateSize(),
          size: options.estimateSize(),
        }),
      ),
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
  resetViewCachesForTests();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  virtualRange.limit = Number.POSITIVE_INFINITY;
  vi.useFakeTimers();
  vi.mocked(native.gitLog)
    .mockReset()
    .mockResolvedValue([commit("a", ["b", "c"]), commit("b", ["c"])]);
  vi.mocked(native.gitCommitFiles).mockReset().mockResolvedValue(files);
  vi.mocked(native.gitCommitMessage).mockResolvedValue("Full message");
  vi.mocked(native.gitRemoteUrl).mockReset().mockResolvedValue("");
  vi.mocked(invoke).mockReset().mockResolvedValue({ kind: "file" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearErrors();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
});
const wait = async (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const renderSearch = (
  props: Partial<React.ComponentProps<typeof GraphSection>> = {},
) =>
  root.render(
    <GraphSection
      repoRoot="/repo"
      headBranch="main"
      headSha="a"
      expanded
      graphRevision="refs-1"
      refreshToken={0}
      showUndoCommit={false}
      mayHavePushedHead={false}
      onDidUndo={() => {}}
      searchOpen
      {...props}
    />,
  );

async function search(query: string) {
  const input = container.querySelector("input");
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!input || !setValue) throw new Error("Missing search input");
  await act(async () => {
    setValue.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function selectSearchField(field: string) {
  const trigger = container.querySelector('[aria-label="searchCategory"]');
  await act(async () =>
    trigger?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ),
  );
  const option = [...document.querySelectorAll('[role="menuitemradio"]')].find(
    (item) => item.textContent === `searchFields.${field}`,
  );
  if (!(option instanceof HTMLElement))
    throw new Error("Missing category option");
  await act(async () => option.click());
  await wait(1);
  expect(document.activeElement).toBe(container.querySelector("input"));
}

it("搜索加载较老的多分支提交不会撑宽已有提交或其展开文件，关闭搜索也无需刷新", async () => {
  const first = Array.from({ length: 40 }, (_, i) => ({
    ...commit(`first${i}`, [`first${i + 1}`]),
    subject: `needle ${i}`,
  }));
  const branch = commit("first40", ["p1", "p2", "p3", "p4", "p5", "p6"]);
  vi.mocked(native.gitLog)
    .mockReset()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce([branch]);
  await act(async () => renderSearch());
  const row = container.querySelector<HTMLButtonElement>(
    'button[aria-label="first0 needle 0"]',
  );
  if (!row) throw new Error("Missing first commit");
  const width = row.querySelector("svg")?.getAttribute("width");
  await act(async () => row.click());
  await search("needle");
  await wait(20);
  expect(row.querySelector("svg")?.getAttribute("width")).toBe(width);
  const file = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes("new.ts"),
  );
  expect(
    file
      ?.closest("[data-commit-row]")
      ?.querySelector("svg")
      ?.getAttribute("width"),
  ).toBe(width);
  await act(async () => renderSearch({ searchOpen: false }));
  expect(row.querySelector("svg")?.getAttribute("width")).toBe(width);
  const merge = container.querySelector(
    'button[aria-label="first40 Commit first40"] svg',
  );
  expect(Number(merge?.getAttribute("width"))).toBeGreaterThan(Number(width));
  expect(native.gitLog).toHaveBeenCalledTimes(2);
});

it("刷新令牌变化后重新读取提交图", async () => {
  vi.mocked(native.gitLog)
    .mockReset()
    .mockResolvedValueOnce([commit("local", [])])
    .mockResolvedValueOnce([commit("remote", ["local"]), commit("local", [])]);
  await act(async () => renderSearch({ searchOpen: false }));
  expect(container.textContent).toContain("Commit local");
  expect(container.textContent).not.toContain("Commit remote");

  await act(async () => renderSearch({ searchOpen: false, refreshToken: 1 }));

  expect(native.gitLog).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Commit remote");
});

it("同仓库慢刷新静默保留列表、展开和焦点，并按阅读锚点更新", async () => {
  await act(async () => renderSearch({ searchOpen: false }));
  const row = container.querySelector<HTMLButtonElement>(
    '[aria-label="a Commit a"]',
  );
  if (!row) throw new Error("缺少提交行");
  await act(async () => row.click());
  await wait(20);
  const scroll = container.querySelector<HTMLElement>(".app-scrollbar");
  if (!scroll) throw new Error("缺少滚动视口");
  let finish!: (commits: GitLogEntry[]) => void;
  vi.mocked(native.gitLog).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => {
    row.focus();
    scroll.scrollTop = 53;
    scroll.dispatchEvent(new Event("scroll"));
    renderSearch({ searchOpen: false, refreshToken: 1 });
  });
  expect(container.querySelector('[aria-label="a Commit a"]')).toBe(row);
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(row);
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  await wait(1_000);
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  expect(container.textContent).not.toContain("loadingCommits");
  await act(async () =>
    finish([commit("new", ["a"]), commit("a", ["b"]), commit("b", [])]),
  );
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  expect(container.querySelector('[aria-label="a Commit a"]')).toBe(row);
  expect(
    container.querySelector('[data-commit-row="a:file:src/new.ts"]'),
  ).not.toBeNull();
  expect(scroll.scrollTop).toBe(77);
  expect(document.activeElement).toBe(row);
  expect(native.gitCommitFiles).toHaveBeenCalledTimes(1);
});

it("刷新失败保留旧内容，重试成功后移除已经消失的展开项", async () => {
  await act(async () => renderSearch({ searchOpen: false }));
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="a Commit a"]')
      ?.click(),
  );
  vi.mocked(native.gitLog).mockRejectedValueOnce(new Error("refresh failed"));
  await act(async () => renderSearch({ searchOpen: false, refreshToken: 1 }));
  expect(container.textContent).toContain("Commit a");
  expect(container.textContent).toContain("refresh failed");
  vi.mocked(native.gitLog).mockResolvedValueOnce([commit("b", [])]);
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "retry",
  );
  await act(async () => retry?.click());
  expect(container.textContent).not.toContain("refresh failed");
  expect(container.querySelector('[data-commit-row="a"]')).toBeNull();
  vi.mocked(native.gitLog).mockResolvedValueOnce([
    commit("a", ["b"]),
    commit("b", []),
  ]);
  await act(async () => renderSearch({ searchOpen: false, refreshToken: 2 }));
  expect(
    container
      .querySelector('[aria-label="a Commit a"]')
      ?.getAttribute("aria-expanded"),
  ).toBe("false");
});

it("切换仓库立即隔离旧列表，迟到的刷新不能覆盖新仓库", async () => {
  await act(async () => renderSearch({ searchOpen: false }));
  let finish!: (commits: GitLogEntry[]) => void;
  vi.mocked(native.gitLog).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => renderSearch({ searchOpen: false, refreshToken: 1 }));
  let load!: (commits: GitLogEntry[]) => void;
  vi.mocked(native.gitLog).mockReturnValueOnce(
    new Promise((resolve) => {
      load = resolve;
    }),
  );
  await act(async () =>
    renderSearch({ repoRoot: "/other", searchOpen: false }),
  );
  expect(container.textContent).not.toContain("Commit a");
  expect(container.textContent).toContain("loadingCommits");
  await act(async () => finish([commit("late", [])]));
  expect(container.textContent).not.toContain("Commit late");
  await act(async () => load([commit("other", [])]));
  expect(container.textContent).toContain("Commit other");
});

it("连续刷新只接纳最新结果，快速完成和顶部阅读均不产生动画或滚动", async () => {
  await act(async () => renderSearch({ searchOpen: false }));
  let finish!: (commits: GitLogEntry[]) => void;
  vi.mocked(native.gitLog).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () =>
    renderSearch({ searchOpen: false, graphRevision: "refs-2" }),
  );
  vi.mocked(native.gitLog).mockResolvedValueOnce([
    commit("latest", ["a"]),
    commit("a", []),
  ]);
  await act(async () =>
    renderSearch({ searchOpen: false, graphRevision: "refs-3" }),
  );
  await act(async () => finish([commit("stale", [])]));
  await wait(500);
  expect(container.textContent).toContain("Commit latest");
  expect(container.textContent).not.toContain("Commit stale");
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  expect(
    container.querySelector<HTMLElement>(".app-scrollbar")?.scrollTop,
  ).toBe(0);
});

it("刷新空结果静默保留空状态，隐藏后重新显示仍可完成刷新", async () => {
  vi.mocked(native.gitLog).mockResolvedValueOnce([]);
  await act(async () => renderSearch({ searchOpen: false }));
  let finish!: (commits: GitLogEntry[]) => void;
  vi.mocked(native.gitLog).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => renderSearch({ searchOpen: false, refreshToken: 1 }));
  expect(container.textContent).toContain("noCommitsYet");
  expect(container.textContent).not.toContain("loadingCommits");
  await wait(1_000);
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  await act(async () =>
    renderSearch({
      searchOpen: false,
      refreshToken: 1,
      expanded: false,
      present: false,
    }),
  );
  await wait(500);
  expect(container.childElementCount).toBe(0);
  await act(async () => finish([commit("first", [])]));
  await act(async () => renderSearch({ searchOpen: false, refreshToken: 1 }));
  expect(container.textContent).toContain("Commit first");
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
});

it.each([1, 80])(
  "刷新新增 %i 条提交时整批替换并保留旧尾部阅读位置",
  async (count) => {
    const history = Array.from({ length: 240 }, (_, index) =>
      commit(String(index), [String(index + 1)]),
    );
    vi.mocked(native.gitLog).mockImplementation(async (_repo, options) =>
      history.slice(
        options?.skip ?? 0,
        (options?.skip ?? 0) + (options?.limit ?? 40),
      ),
    );
    await act(async () => renderSearch({ searchOpen: false }));
    const scroll = container.querySelector<HTMLElement>(".app-scrollbar");
    if (!scroll) throw new Error("缺少滚动视口");
    Object.defineProperty(scroll, "scrollHeight", { value: 6000 });
    Object.defineProperty(scroll, "clientHeight", { value: 200 });
    for (let page = 0; page < 5; page++) {
      scroll.scrollTop = 5900;
      await act(async () => scroll.dispatchEvent(new Event("scroll")));
    }
    expect(container.querySelector('[data-commit-row="239"]')).not.toBeNull();
    await act(async () => {
      scroll.scrollTop = 230 * 24 + 5;
      scroll.dispatchEvent(new Event("scroll"));
    });
    const withNew = [
      ...Array.from({ length: count }, (_, index) =>
        commit(index === 0 ? "new" : `new-${index}`, []),
      ),
      ...history,
    ];
    vi.mocked(native.gitLog)
      .mockClear()
      .mockImplementation(async (_repo, options) => {
        if (options?.skip) throw new Error("second page failed");
        return withNew.slice(0, options?.limit);
      });
    await act(async () => renderSearch({ searchOpen: false, refreshToken: 1 }));
    expect(native.gitLog).toHaveBeenNthCalledWith(1, "/repo", { limit: 200 });
    expect(container.textContent).not.toContain("Commit new");
    expect(container.querySelector('[data-commit-row="239"]')).not.toBeNull();
    vi.mocked(native.gitLog)
      .mockClear()
      .mockImplementation(async (_repo, options) =>
        withNew.slice(
          options?.skip ?? 0,
          (options?.skip ?? 0) + (options?.limit ?? 40),
        ),
      );
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "retry",
    );
    await act(async () => retry?.click());
    expect(native.gitLog).toHaveBeenNthCalledWith(2, "/repo", {
      limit: 40 + count,
      skip: 200,
    });
    expect(native.gitLog).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-commit-row="239"]')).not.toBeNull();
    expect(scroll.scrollTop).toBe((230 + count) * 24 + 5);
    expect(container.textContent).toContain("Commit new");
    expect(container.querySelector('[data-commit-row="239"]')).not.toBeNull();
    vi.mocked(native.gitLog).mockClear();
    await act(async () => renderSearch({ searchOpen: false, refreshToken: 2 }));
    expect(native.gitLog).toHaveBeenCalledTimes(2);
  },
);

it("引用 revision 变化后重新读取提交图", async () => {
  vi.mocked(native.gitLog)
    .mockReset()
    .mockResolvedValueOnce([commit("before", [])])
    .mockResolvedValueOnce([commit("after", ["before"]), commit("before", [])]);

  await act(async () => renderSearch({ searchOpen: false }));
  await act(async () =>
    renderSearch({ graphRevision: "refs-2", searchOpen: false }),
  );

  expect(native.gitLog).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Commit after");
});

it("同一提交切换分支后重新读取引用", async () => {
  vi.mocked(native.gitLog)
    .mockReset()
    .mockResolvedValueOnce([
      { ...commit("a", []), refs: [{ kind: "local", label: "nightly" }] },
    ])
    .mockResolvedValueOnce([
      { ...commit("a", []), refs: [{ kind: "local", label: "master" }] },
    ]);
  await act(async () =>
    renderSearch({ headBranch: "nightly", searchOpen: false }),
  );
  expect(container.textContent).toContain("nightly");

  await act(async () =>
    renderSearch({ headBranch: "master", searchOpen: false }),
  );

  expect(native.gitLog).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("master");
  expect(container.textContent).not.toContain("nightly");
});

it("提交说明搜索高亮全部匹配片段，切换类别后不误高亮标题", async () => {
  const subject = "Alpha: fix alpha and ALPHA";
  vi.mocked(native.gitLog).mockResolvedValue([
    { ...commit("a", []), subject, author: "alpha" },
    { ...commit("b", []), author: "alpha" },
  ]);
  const open = vi.fn();
  await act(async () => renderSearch({ onOpenCommitFile: open }));
  await search("alpha");
  expect(
    [...container.querySelectorAll("mark")].map((mark) => mark.textContent),
  ).toEqual(["Alpha", "alpha", "ALPHA"]);
  const row = container.querySelector<HTMLButtonElement>(
    "button[aria-expanded]:not([aria-haspopup])",
  );
  await act(async () => row?.click());
  const file = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes("new.ts"),
  );
  await act(async () => file?.click());
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ subject }));
  await selectSearchField("author");
  expect(
    container.querySelectorAll("button[aria-expanded]:not([aria-haspopup])"),
  ).toHaveLength(2);
  expect(container.querySelectorAll("mark")).toHaveLength(0);
  await selectSearchField("subject");
  await search("");
  expect(container.querySelectorAll("mark")).toHaveLength(0);
});

it("搜索继续读取历史分页，找到旧提交后仍可展开并打开 Diff", async () => {
  const first = Array.from({ length: 40 }, (_, i) => commit(`first${i}`, []));
  const next = Array.from({ length: 200 }, (_, i) => commit(`next${i}`, []));
  const target = { ...commit("old", []), subject: "needle" };
  vi.mocked(native.gitLog)
    .mockReset()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(next)
    .mockResolvedValueOnce([target]);
  const open = vi.fn();
  await act(async () => renderSearch({ onOpenCommitFile: open }));
  expect(document.activeElement).toBe(container.querySelector("input"));
  await search("needle");
  await wait(20);
  await wait(20);
  expect(native.gitLog).toHaveBeenNthCalledWith(2, "/repo", {
    limit: 200,
    skip: 40,
  });
  expect(native.gitLog).toHaveBeenNthCalledWith(3, "/repo", {
    limit: 200,
    skip: 240,
  });
  const matches = container.querySelectorAll<HTMLButtonElement>(
    "button[aria-expanded]:not([aria-haspopup])",
  );
  expect(matches).toHaveLength(1);
  expect(matches[0].textContent).toContain("needle");
  expect(container.textContent).not.toContain("searchingHistory");
  await act(async () => matches[0].click());
  const file = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("new.ts"),
  );
  await act(async () => file?.click());
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ sha: "old", path: "src/new.ts" }),
  );
});

it("作者、邮箱和完整 SHA 均可匹配，关闭搜索恢复列表和展开项", async () => {
  vi.mocked(native.gitLog).mockResolvedValue([
    {
      ...commit("abcdef123456", []),
      shortSha: "abcdef",
      author: "Alice",
      authorEmail: "alice@example.org",
    },
    { ...commit("other", []), author: "Bob" },
  ]);
  const close = vi.fn();
  await act(async () => renderSearch({ onCloseSearch: close }));
  const row = container.querySelector<HTMLButtonElement>(
    "button[aria-expanded]:not([aria-haspopup])",
  );
  await act(async () => row?.click());
  await search("ALICE");
  expect(
    container.querySelectorAll("button[aria-expanded]:not([aria-haspopup])"),
  ).toHaveLength(0);
  for (const [field, query] of [
    ["author", "ALICE"],
    ["authorEmail", "example.org"],
    ["sha", "123456"],
  ]) {
    await selectSearchField(field);
    await search(query);
    expect(
      container.querySelectorAll("button[aria-expanded]:not([aria-haspopup])"),
    ).toHaveLength(1);
  }
  await search("missing");
  expect(container.textContent).toContain("noSearchResults");
  await act(async () =>
    container
      .querySelector("input")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
  );
  expect(close).toHaveBeenCalledOnce();
  await act(async () => renderSearch({ searchOpen: false }));
  expect(
    container.querySelectorAll("button[aria-expanded]:not([aria-haspopup])"),
  ).toHaveLength(2);
  expect(
    container
      .querySelector("button[aria-expanded]:not([aria-haspopup])")
      ?.getAttribute("aria-expanded"),
  ).toBe("true");
  await act(async () => renderSearch());
  expect(container.querySelector("input")?.value).toBe("");
});

it("搜索分页失败后等待手动重试，不循环请求或误报搜索结束", async () => {
  vi.mocked(native.gitLog)
    .mockReset()
    .mockResolvedValueOnce(
      Array.from({ length: 40 }, (_, i) => commit(String(i), [])),
    )
    .mockRejectedValueOnce(new Error("page failed"))
    .mockResolvedValueOnce([{ ...commit("old", []), subject: "needle" }]);
  await act(async () => renderSearch());
  await search("needle");
  await wait(20);
  expect(container.textContent).toContain("page failed");
  expect(container.textContent).not.toContain("noSearchResults");
  await wait(1000);
  expect(native.gitLog).toHaveBeenCalledTimes(2);
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "retry",
  );
  await act(async () => retry?.click());
  expect(container.textContent).toContain("needle");
});

it("隐藏 Graph 时暂停搜索分页，恢复后等待用户重新查询", async () => {
  let finish!: (entries: GitLogEntry[]) => void;
  vi.mocked(native.gitLog)
    .mockReset()
    .mockResolvedValueOnce(
      Array.from({ length: 40 }, (_, i) => commit(String(i), [])),
    )
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValueOnce([]);
  await act(async () => renderSearch());
  await search("needle");
  await wait(5);
  await act(async () => renderSearch({ expanded: false }));
  await act(async () =>
    finish(Array.from({ length: 200 }, (_, i) => commit(`next${i}`, []))),
  );
  await wait(20);
  expect(native.gitLog).toHaveBeenCalledTimes(2);
  await act(async () => renderSearch());
  await wait(20);
  expect(native.gitLog).toHaveBeenCalledTimes(2);
  // 恢复阅读位置触发的滚动也不能重启旧查询。
  await act(async () =>
    container
      .querySelector(".app-scrollbar")
      ?.dispatchEvent(new Event("scroll")),
  );
  await wait(20);
  expect(native.gitLog).toHaveBeenCalledTimes(2);
  await search("another");
  await wait(20);
  expect(native.gitLog).toHaveBeenCalledTimes(3);
});

it("侧边栏详情可打开当前提交的远端链接", async () => {
  vi.mocked(native.gitRemoteUrl).mockResolvedValue(
    "git@github.com:owner/repo.git",
  );
  await act(async () => renderSearch({ searchOpen: false }));
  const row = container.querySelector(
    "button[aria-expanded]:not([aria-haspopup])",
  );
  await act(async () =>
    row?.dispatchEvent(
      new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }),
    ),
  );
  await wait(800);
  const remote = [...document.querySelectorAll('[role="dialog"] button')].find(
    (button) => button.textContent === "viewOn",
  );
  if (!(remote instanceof HTMLButtonElement))
    throw new Error("Missing remote action");
  await act(async () => remote.click());
  expect(openUrl).toHaveBeenLastCalledWith(
    "https://github.com/owner/repo/commit/a",
  );
});

it("侧边栏重复挂载检查仍能完成加载，折叠分组后保留提交展开状态", async () => {
  const render = (expanded: boolean) =>
    root.render(
      <StrictMode>
        <GraphSection
          repoRoot="/repo"
          headBranch="main"
          headSha="a"
          expanded={expanded}
          graphRevision="refs-1"
          refreshToken={0}
          showUndoCommit={false}
          mayHavePushedHead={false}
          onDidUndo={() => {}}
        />
      </StrictMode>,
    );
  await act(async () => render(true));
  const row = container.querySelector<HTMLButtonElement>(
    "button[aria-expanded]:not([aria-haspopup])",
  );
  if (!row) throw new Error("Missing commit row");
  await act(async () => row.click());
  await act(async () => render(false));
  await act(async () => render(true));
  expect(
    container
      .querySelector("button[aria-expanded]:not([aria-haspopup])")
      ?.getAttribute("aria-expanded"),
  ).toBe("true");
  expect(native.gitCommitFiles).toHaveBeenCalledTimes(1);
});

it("提交详情与展开文件提供独立的工作区文件和 Diff 入口", async () => {
  const open = vi.fn();
  const openFile = vi.fn();
  await act(async () =>
    root.render(
      <GraphSection
        repoRoot="/repo"
        headBranch="main"
        headSha="a"
        expanded
        graphRevision="refs-1"
        refreshToken={0}
        showUndoCommit={false}
        mayHavePushedHead={false}
        onDidUndo={() => {}}
        onOpenCommitFile={open}
        onOpenFile={openFile}
      />,
    ),
  );
  const rows = () => [
    ...container.querySelectorAll<HTMLButtonElement>(
      "button[aria-expanded]:not([aria-haspopup])",
    ),
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
  const floatingOpen = panel.querySelector(
    'button[aria-label="menu.openFile"]',
  );
  const status = floatingFile.querySelector(
    'span[data-slot="tooltip-trigger"]',
  );
  expect(floatingOpen?.parentElement?.classList.contains("col-start-2")).toBe(
    true,
  );
  expect(status?.classList.contains("col-start-3")).toBe(true);
  expect(status?.nextElementSibling?.classList.contains("col-start-4")).toBe(
    true,
  );
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
  expect(invoke).not.toHaveBeenCalled();
  const openWorking = expandedFiles[0]
    .closest("[data-commit-row]")
    ?.querySelector<HTMLButtonElement>('button[aria-label="menu.openFile"]');
  expect(openWorking).toBeDefined();
  await act(async () => openWorking?.click());
  expect(invoke).toHaveBeenCalledExactlyOnceWith("fs_stat", {
    path: "/repo/src/new.ts",
    workspace: { kind: "local" },
  });
  expect(openFile).toHaveBeenCalledExactlyOnceWith("/repo/src/new.ts", "/repo");
  expect(open).toHaveBeenCalledTimes(2);
  expect(native.gitCommitFiles).toHaveBeenCalledTimes(2);
  // 合并提交展开区域延续两个底部轨道，且不重复绘制节点。
  const continuation = expandedFiles[0]
    .closest("[data-commit-row]")
    ?.querySelector("svg");
  expect(continuation?.querySelectorAll("line")).toHaveLength(2);
  expect(continuation?.querySelector("circle")).toBeNull();
  await act(async () => rows()[0].click());
  expect(rows().map((row) => row.getAttribute("aria-expanded"))).toEqual([
    "false",
    "true",
  ]);
});

it("历史文件在工作区缺失时提示错误且不打开标签", async () => {
  const openFile = vi.fn();
  vi.mocked(invoke).mockRejectedValueOnce("missing");
  await act(async () => renderSearch({ onOpenFile: openFile }));
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('button[aria-label="a Commit a"]')
      ?.click(),
  );
  const openWorking = container.querySelector<HTMLButtonElement>(
    'button[aria-label="menu.openFile"]',
  );
  expect(openWorking).not.toBeNull();
  await act(async () => openWorking?.click());
  expect(openFile).not.toHaveBeenCalled();
  expect(errorStore.getState().reports).toEqual([
    expect.objectContaining({
      title: "openWorkingFileFailed",
      details: "missing",
    }),
  ]);
});

it("切换仓库后忽略旧工作区文件检查的结果", async () => {
  const openFile = vi.fn();
  let finishStat: (stat: { kind: "file" }) => void = () => {};
  vi.mocked(invoke).mockReturnValueOnce(
    new Promise((resolve) => {
      finishStat = resolve;
    }),
  );
  await act(async () => renderSearch({ onOpenFile: openFile }));
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('button[aria-label="a Commit a"]')
      ?.click(),
  );
  const openWorking = container.querySelector<HTMLButtonElement>(
    'button[aria-label="menu.openFile"]',
  );
  expect(openWorking).not.toBeNull();
  await act(async () => openWorking?.click());
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () =>
    renderSearch({ repoRoot: "/other", onOpenFile: openFile }),
  );
  await act(async () => finishStat({ kind: "file" }));
  expect(openFile).not.toHaveBeenCalled();
});

it("点击历史提交文件后保留唯一选中状态", async () => {
  const nextFile: GitCommitFileChange = {
    ...files[0],
    path: "src/next.ts",
    originalPath: null,
    status: "M",
    statusLabel: "Modified",
  };
  vi.mocked(native.gitCommitFiles).mockResolvedValue([files[0], nextFile]);
  const open = vi.fn();
  await act(async () => renderSearch({ onOpenCommitFile: open }));
  const commitRow = container.querySelector<HTMLButtonElement>(
    "button[aria-expanded]:not([aria-haspopup])",
  );
  await act(async () => commitRow?.click());

  const fileRows = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .filter((button) =>
      ["new.ts", "next.ts"].some((name) => button.textContent?.includes(name)),
    )
    .slice(-2);
  expect(fileRows).toHaveLength(2);

  await act(async () => fileRows[0].click());
  expect(fileRows[0].getAttribute("aria-current")).toBe("true");
  expect(fileRows[1].hasAttribute("aria-current")).toBe(false);

  await act(async () => fileRows[1].click());
  expect(fileRows[0].hasAttribute("aria-current")).toBe(false);
  expect(fileRows[1].getAttribute("aria-current")).toBe("true");
  expect(open).toHaveBeenLastCalledWith(
    expect.objectContaining({ sha: "a", path: "src/next.ts" }),
  );
});

it("键盘可展开文件、进入悬停详情，并用 Esc 返回提交行", async () => {
  await act(async () =>
    root.render(
      <GraphSection
        repoRoot="/repo"
        headBranch="main"
        headSha="a"
        expanded
        graphRevision="refs-1"
        refreshToken={0}
        showUndoCommit={false}
        mayHavePushedHead={false}
        onDidUndo={() => {}}
      />,
    ),
  );
  const row = container.querySelector<HTMLButtonElement>(
    "button[aria-expanded]:not([aria-haspopup])",
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

it.each(["click", "keyboard"])(
  "大提交通过 %s 收起时，新进入视口的标题接续动画",
  async (interaction) => {
    virtualRange.limit = 6;
    vi.mocked(native.gitCommitFiles).mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => ({
        ...files[0],
        path: `file-${index}`,
      })),
    );
    await act(async () => renderSearch({ searchOpen: false }));
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="a Commit a"]',
    );
    if (!trigger) throw new Error("缺少提交入口");
    const scroll = trigger.closest(".app-scrollbar");
    Object.defineProperty(scroll, "clientHeight", { value: 240 });
    await act(async () => trigger.click());
    await wait(1);
    expect(container.querySelector('[data-commit-row="b"]')).toBeNull();
    const file = container.querySelector('[data-commit-row="a:file:file-0"]');
    const starts = new Map<HTMLElement, Keyframe[]>();
    const animations: Animation[] = [];
    HTMLElement.prototype.animate = function (frames) {
      starts.set(this, frames as Keyframe[]);
      const animation = {
        cancel: vi.fn(),
        onfinish: null,
        oncancel: null,
      } as unknown as Animation;
      animations.push(animation);
      return animation;
    };
    await act(async () =>
      interaction === "click"
        ? trigger.click()
        : trigger.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
          ),
    );
    const next = container.querySelector<HTMLElement>('[data-commit-row="b"]');
    expect(next).not.toBeNull();
    expect(starts.get(next as HTMLElement)?.[0].translate).toBe("0 240px");
    expect(
      container.querySelectorAll("[data-commit-row]").length,
    ).toBeLessThanOrEqual(8);
    expect(file?.isConnected && file.hasAttribute("inert")).toBe(true);
    await act(async () => trigger.click());
    expect(container.querySelector('[data-commit-row="a:file:file-0"]')).toBe(
      file,
    );
    expect(file?.hasAttribute("inert")).toBe(false);
    await act(async () => trigger.click());
    act(() => {
      const animation = animations.find((item) => item.onfinish);
      animation?.onfinish?.call(animation, {} as AnimationPlaybackEvent);
      // 在 React 提交卸载之前检查：动画清理不能让退出内容重新可见。
      expect((file as HTMLElement).style.height).toBe("0px");
      expect((file as HTMLElement).style.overflow).toBe("");
    });
    expect(file?.isConnected).toBe(false);
    expect(native.gitCommitFiles).toHaveBeenCalledTimes(1);
  },
);

it("分组退出后释放展示树，重新展开复用提交和文件缓存", async () => {
  await act(async () => renderSearch({ searchOpen: false }));
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="a Commit a"]',
  );
  if (!trigger) throw new Error("缺少提交入口");
  await act(async () => trigger.click());
  await wait(1);
  const scroll = trigger.closest<HTMLElement>(".app-scrollbar");
  if (!scroll) throw new Error("缺少滚动视口");
  await act(async () => {
    scroll.scrollTop = 48;
    scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const calls = vi.mocked(native.gitLog).mock.calls.length;
  await act(async () =>
    renderSearch({ expanded: false, present: true, searchOpen: false }),
  );
  expect(container.querySelector("[data-commit-row]")).not.toBeNull();
  await act(async () =>
    renderSearch({ expanded: false, present: false, searchOpen: false }),
  );
  expect(container.childElementCount).toBe(0);
  await act(async () => renderSearch({ searchOpen: false }));
  expect(
    container.querySelector('[data-commit-row="a:file:src/new.ts"]'),
  ).not.toBeNull();
  expect(
    container.querySelector<HTMLElement>(".app-scrollbar")?.scrollTop,
  ).toBe(48);
  expect(native.gitLog).toHaveBeenCalledTimes(calls);
  expect(native.gitCommitFiles).toHaveBeenCalledTimes(1);
});

// @vitest-environment happy-dom

import {
  type GitCommitFileChange,
  type GitLogEntry,
  native,
} from "@/modules/ai/lib/native";
import {
  flattenCommitRows,
  useCommitGraph,
} from "@/modules/git-history/useCommitGraph";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/modules/ai/lib/native", () => ({
  native: { gitCommitFiles: vi.fn(), gitCommitMessage: vi.fn() },
}));
let container: HTMLDivElement;
let row: HTMLButtonElement;
let root: ReturnType<typeof createRoot>;
let graph: ReturnType<typeof useCommitGraph>;
function Harness({
  repo = "/repo",
  visible = true,
}: {
  repo?: string;
  visible?: boolean;
}) {
  graph = useCommitGraph(repo, visible);
  return null;
}
const file = {
  path: "src/new.ts",
  originalPath: "src/old.ts",
  status: "R",
  statusLabel: "Renamed",
  added: 12,
  removed: 3,
  isBinary: false,
} as GitCommitFileChange;
const commit = (sha: string) => ({ sha }) as GitLogEntry;
const wait = async (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
beforeEach(async () => {
  vi.useFakeTimers();
  vi.mocked(native.gitCommitFiles).mockReset().mockResolvedValue([file]);
  vi.mocked(native.gitCommitMessage).mockReset().mockResolvedValue("message");
  container = document.createElement("div");
  row = document.createElement("button");
  document.body.append(container, row);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  row.remove();
  vi.useRealTimers();
});

it("首次等待 800ms，显示中切换及关闭后 500ms 内免等待，快速扫过不请求", async () => {
  await act(async () => graph.enter("a", row));
  await wait(799);
  expect(graph.anchor).toBeNull();
  expect(native.gitCommitFiles).not.toHaveBeenCalled();
  await wait(1);
  expect(graph.anchor?.sha).toBe("a");
  await act(async () => graph.enter("b", row));
  expect(graph.anchor?.sha).toBe("b");
  await act(async () => graph.close());
  await wait(499);
  await act(async () => graph.enter("c", row));
  expect(graph.anchor?.sha).toBe("c");
  await act(async () => graph.close());
  await wait(500);
  await act(async () => graph.enter("d", row));
  await wait(799);
  expect(graph.anchor).toBeNull();
  await act(async () => graph.leave());
  await wait(1000);
  expect(native.gitCommitFiles).toHaveBeenCalledTimes(3);
});

it("移入浮层保持显示，点击展开后原位不会再次弹出", async () => {
  await act(async () => graph.enter("a", row));
  await wait(800);
  await act(async () => graph.leave());
  await wait(50);
  await act(async () => graph.keepOpen());
  await wait(1000);
  expect(graph.anchor?.sha).toBe("a");
  await act(async () => graph.toggle("a"));
  await act(async () => graph.enter("a", row));
  await wait(1000);
  expect(graph.anchor).toBeNull();
  expect(graph.expanded.has("a")).toBe(true);
  await act(async () => {
    graph.leave();
    graph.enter("a", row);
  });
  await wait(800);
  expect(graph.anchor?.sha).toBe("a");
  expect(native.gitCommitFiles).toHaveBeenCalledTimes(1);
});

it("允许多个提交展开，浮层与子行共用请求，折叠只影响目标提交", async () => {
  let resolve!: (files: GitCommitFileChange[]) => void;
  vi.mocked(native.gitCommitFiles).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await act(async () => graph.enter("a", row, true));
  await act(async () => {
    graph.toggle("a");
    graph.toggle("b");
  });
  expect(native.gitCommitFiles).toHaveBeenCalledTimes(2);
  expect(
    flattenCommitRows(
      [commit("a"), commit("b")],
      graph.expanded,
      graph.files,
    ).map((item) => item.kind),
  ).toEqual(["commit", "status", "commit", "file"]);
  await act(async () => resolve([file]));
  expect(
    flattenCommitRows(
      [commit("a"), commit("b")],
      graph.expanded,
      graph.files,
    ).map((item) => item.key),
  ).toEqual(["a", "a:file:src/new.ts", "b", "b:file:src/new.ts"]);
  await act(async () => graph.toggle("a"));
  expect([...graph.expanded]).toEqual(["b"]);
  expect(native.gitCommitFiles).toHaveBeenCalledTimes(2);
});

it("隐藏、滚动关闭和卸载均取消待显示浮层，隐藏不清除展开项", async () => {
  await act(async () => {
    graph.toggle("b");
    graph.enter("a", row);
  });
  await act(async () => root.render(<Harness visible={false} />));
  await wait(1000);
  expect(graph.anchor).toBeNull();
  expect(graph.expanded.has("b")).toBe(true);
  await act(async () => root.render(<Harness />));
  await act(async () => graph.enter("a", row));
  await act(async () => graph.close());
  await wait(1000);
  expect(graph.anchor).toBeNull();
  await act(async () => graph.enter("a", row));
  await act(async () => root.render(null));
  await wait(1000);
  expect(native.gitCommitFiles).toHaveBeenCalledTimes(1);
});

it("仓库切换拒绝旧详情回写，同 SHA 在新仓库重新加载", async () => {
  let resolve!: (files: GitCommitFileChange[]) => void;
  vi.mocked(native.gitCommitFiles).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await act(async () => graph.toggle("a"));
  await act(async () => root.render(<Harness repo="/other" />));
  await act(async () => graph.toggle("a"));
  await act(async () => resolve([]));
  expect(graph.files.get("a")).toMatchObject({
    state: "loaded",
    files: [file],
  });
  expect(native.gitCommitFiles).toHaveBeenLastCalledWith("/other", "a");
});

it("详情失败可重试，失败不会重复请求或误报空文件", async () => {
  vi.mocked(native.gitCommitFiles).mockRejectedValueOnce(
    new Error("unavailable"),
  );
  await act(async () => graph.toggle("a"));
  expect(graph.files.get("a")).toEqual({
    state: "error",
    error: "unavailable",
  });
  await act(async () => graph.fetchFiles("a"));
  expect(native.gitCommitFiles).toHaveBeenCalledTimes(1);
  await act(async () => graph.fetchFiles("a", true));
  expect(graph.files.get("a")).toMatchObject({
    state: "loaded",
    files: [file],
  });
});

it("悬停缓存淘汰不会清除已展开文件", async () => {
  await act(async () => graph.toggle("pinned"));
  for (let index = 0; index < 20; index++)
    await act(async () => graph.fetchFiles(String(index)));
  expect(graph.files.has("pinned")).toBe(true);
  expect(graph.files.size).toBeLessThanOrEqual(17);
});

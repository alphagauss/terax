/**
 * 本文件测试共享文档 Hook 与只读 Repository Context 的连接。
 * 锁定文本打开后会按仓库与 HEAD 请求一次基线，并把结果发布给编辑器。
 */

// @vitest-environment happy-dom

import { RepositoryProvider } from "@/modules/source-control/RepositoryContext";
import type { RepositoryController } from "@/modules/source-control/useRepositoryController";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  activeFileListener: null as (() => void) | null,
  resumeListener: null as (() => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
// 文档协调测试隔离字节协议；检查点与完整性校验由 fileSync.test.ts 覆盖。
vi.mock("./fileSync", () => ({
  FileSyncReader: class {
    clear() {}
    read(path: string, workspace: unknown, force: boolean, verify: boolean) {
      return mocks.invoke("fs_sync_file", { path, workspace, force, verify });
    }
  },
}));
vi.mock("@/modules/filesystem", () => ({
  subscribeActiveFile: vi.fn(
    (_workspace: unknown, _path: string, listener: () => void) => {
      mocks.activeFileListener = listener;
      queueMicrotask(listener);
      return () => {
        if (mocks.activeFileListener === listener) {
          mocks.activeFileListener = null;
        }
      };
    },
  ),
  subscribeWorkspaceResume: vi.fn((listener: () => void) => {
    mocks.resumeListener = listener;
    return () => {
      if (mocks.resumeListener === listener) mocks.resumeListener = null;
    };
  }),
}));
vi.mock("@/modules/lsp", () => ({ notifyDocumentSaved: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { warning: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("@/lib/errors", () => ({ reportError: vi.fn() }));

import { resetSharedDocumentModelsForTests } from "./documentModel";
import { useDocument } from "./useDocument";

const controller = {
  repo: {
    repoRoot: "C:/work",
    branch: "main",
    upstream: null,
    isDetached: false,
  },
  status: {
    repoRoot: "C:/work",
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
  revision: 1,
  graphRevision: null,
  refresh: vi.fn(),
  runRemoteAction: vi.fn(),
} satisfies RepositoryController;

let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  resetSharedDocumentModelsForTests();
  vi.clearAllMocks();
  mocks.activeFileListener = null;
  mocks.resumeListener = null;
  document.body.replaceChildren();
});

describe("useDocument", () => {
  it("refreshes ignore eligibility in both directions without polling unchanged baselines", async () => {
    let ignored = true;
    let reads = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "fs_sync_file") {
        return {
          kind: "text",
          content: "log\n",
          size: 4,
          mtime: 1,
          revision: "disk",
        };
      }
      if (command === "git_quick_diff_baseline") {
        reads += 1;
        return ignored
          ? { kind: "ignored" }
          : {
              kind: "text",
              repoRoot: "C:/work",
              relativePath: "logs/app.log",
              headSha: "head",
              content: "",
            };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    function Probe() {
      const state = useDocument({ path: "C:/work/logs/app.log" });
      return <span>{state.gitBaseline === null ? "disabled" : "enabled"}</span>;
    }
    let revision = 0;
    const refresh = async (truncated = false, clean = false) => {
      await act(async () =>
        root?.render(
          <RepositoryProvider
            controller={{
              ...controller,
              revision: ++revision,
              status: {
                ...controller.status,
                truncated,
                changedFiles:
                  ignored || truncated || clean
                    ? []
                    : [
                        {
                          path: "logs/app.log",
                          indexStatus: "?",
                          worktreeStatus: "?",
                          originalPath: null,
                          staged: false,
                          unstaged: false,
                          untracked: true,
                          statusLabel: "untracked",
                        },
                      ],
              },
            }}
          >
            <Probe />
          </RepositoryProvider>,
        ),
      );
    };
    await refresh();
    expect(reads).toBe(1);
    await refresh();
    expect(reads).toBe(1);
    ignored = false;
    await refresh();
    expect(container.textContent).toBe("enabled");
    expect(reads).toBe(2);
    await refresh();
    expect(reads).toBe(2);
    ignored = true;
    await refresh();
    expect(container.textContent).toBe("disabled");
    expect(reads).toBe(3);
    await refresh();
    expect(reads).toBe(3);
    // 截断列表不能证明文件仍被忽略，需允许重新查询。
    ignored = false;
    await refresh(true);
    expect(container.textContent).toBe("enabled");
    expect(reads).toBe(4);
    // 已跟踪文件恢复干净后也会从列表消失，但仍需保留基线以显示未保存编辑。
    await refresh(false, true);
    expect(container.textContent).toBe("enabled");
    expect(reads).toBe(5);
    await refresh(false, true);
    expect(reads).toBe(5);
  });

  it("publishes the repository HEAD baseline after loading a text document", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "fs_sync_file") {
        return {
          kind: "text",
          content: "current\n",
          size: 8,
          mtime: 1,
          revision: "disk",
        };
      }
      if (command === "git_quick_diff_baseline") {
        return {
          kind: "text",
          repoRoot: "C:/work",
          relativePath: "file.ts",
          headSha: "head",
          content: "baseline\n",
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    function Probe() {
      const document = useDocument({ path: "C:/work/file.ts" });
      return <span>{document.gitBaseline ?? "missing"}</span>;
    }

    await act(async () => {
      root?.render(
        <RepositoryProvider controller={controller}>
          <Probe />
        </RepositoryProvider>,
      );
    });

    await vi.waitFor(() => expect(container.textContent).toBe("baseline\n"));
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "git_quick_diff_baseline",
      ),
    ).toHaveLength(1);
  });

  it("reconciles a visible document directly after a filesystem invalidation", async () => {
    let disk = {
      kind: "text",
      content: "before\n",
      size: 7,
      mtime: 1,
      revision: "before",
    };
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "fs_sync_file") return disk;
      if (command === "git_quick_diff_baseline") {
        return { kind: "unsupported" };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    function Probe() {
      const state = useDocument({ path: "C:/work/readme.md", active: true });
      return (
        <span>
          {state.doc.status === "ready" ? state.doc.content : "loading"}
        </span>
      );
    }

    await act(async () => {
      root?.render(
        <RepositoryProvider controller={controller}>
          <Probe />
        </RepositoryProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toBe("before\n"));

    disk = {
      kind: "text",
      content: "after\n",
      size: 6,
      mtime: 2,
      revision: "after",
    };
    await act(async () => mocks.activeFileListener?.());

    await vi.waitFor(() => expect(container.textContent).toBe("after\n"));
  });

  it("revalidates a cached document when its tab is reopened", async () => {
    let disk = {
      kind: "text",
      content: "before\n",
      size: 7,
      mtime: 1,
      revision: "before",
    };
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "fs_sync_file") return disk;
      if (command === "git_quick_diff_baseline") {
        return { kind: "unsupported" };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const container = document.createElement("div");
    document.body.append(container);

    function Probe() {
      const state = useDocument({ path: "C:/work/readme.md", active: true });
      return (
        <span>
          {state.doc.status === "ready" ? state.doc.content : "loading"}
        </span>
      );
    }
    const renderProbe = () =>
      root?.render(
        <RepositoryProvider controller={controller}>
          <Probe />
        </RepositoryProvider>,
      );

    root = createRoot(container);
    await act(async () => renderProbe());
    await vi.waitFor(() => expect(container.textContent).toBe("before\n"));

    await act(async () => root?.unmount());
    disk = {
      kind: "text",
      content: "after\n",
      size: 6,
      mtime: 2,
      revision: "after",
    };
    root = createRoot(container);
    await act(async () => renderProbe());

    await vi.waitFor(() => expect(container.textContent).toBe("after\n"));
  });
});

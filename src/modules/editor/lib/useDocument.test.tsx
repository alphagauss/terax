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

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/modules/lsp", () => ({ notifyDocumentSaved: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { warning: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
}));

import { resetSharedDocumentModelsForTests } from "./documentModel";
import { useDocument } from "./useDocument";

const controller: RepositoryController = {
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
  localError: null,
  busyAction: null,
  lastRemoteError: null,
  revision: 1,
  graphRevision: null,
  refresh: vi.fn(),
  runRemoteAction: vi.fn(),
};

let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  resetSharedDocumentModelsForTests();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("useDocument", () => {
  it("publishes the repository HEAD baseline after loading a text document", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "fs_read_file") {
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
});

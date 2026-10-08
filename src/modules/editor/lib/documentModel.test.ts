/**
 * 本文件测试共享文档模型的内容版本协调、Git 基线、保存冲突、自动保存与生命周期。
 *
 * 磁盘元数据不得制造冲突，真实的双向内容变化不得被自动覆盖。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  notifyDocumentSaved: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/modules/lsp", () => ({
  notifyDocumentSaved: mocks.notifyDocumentSaved,
}));
vi.mock("sonner", () => ({
  toast: {
    warning: mocks.warning,
    error: mocks.error,
    dismiss: mocks.dismiss,
  },
}));

import { usePreferencesStore } from "@/modules/settings/preferences";
import type { WorkspaceEnv } from "@/modules/workspace";
import {
  discardSharedDocumentModel,
  documentResourceKey,
  getSharedDocumentModel,
  resetSharedDocumentModelsForTests,
  saveAutoSaveDocumentsBeforeClose,
} from "./documentModel";

const local = { kind: "local" } satisfies WorkspaceEnv;

function text(content: string, revision = `revision:${content}`, mtime = 1) {
  return {
    kind: "text",
    content,
    size: new TextEncoder().encode(content).byteLength,
    mtime,
    revision,
  };
}

function written(content: string, mtime = 2) {
  return {
    status: "written",
    revision: `revision:${content}`,
    size: new TextEncoder().encode(content).byteLength,
    mtime,
  };
}

function observed(content: string, mtime = 2) {
  return {
    size: new TextEncoder().encode(content).byteLength,
    mtime,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("shared document model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePreferencesStore.setState({
      editorAutoSave: false,
      editorAutoSaveDelay: 1000,
    });
    mocks.invoke.mockImplementation(
      async (command: string, args?: { content?: string }) => {
        if (command === "fs_read_file") return text("one\n");
        if (command === "fs_stat") {
          return { kind: "file", size: 4, mtime: 1 };
        }
        if (command === "fs_write_file_checked") {
          return written(args?.content ?? "");
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    resetSharedDocumentModelsForTests();
  });

  it("keys all views by workspace and normalized path", () => {
    const first = getSharedDocumentModel(local, "C:\\work\\file.ts");
    const second = getSharedDocumentModel(local, "c:/work/file.ts");
    const remote = getSharedDocumentModel(
      { kind: "ssh", profileId: "dev" },
      "c:/work/file.ts",
    );

    expect(second).toBe(first);
    expect(remote).not.toBe(first);
    expect(documentResourceKey(local, "C:\\work\\file.ts")).toBe(
      documentResourceKey(local, "c:/work/file.ts"),
    );
  });

  it("polls SSH documents only while at least one view is visible", () => {
    const model = getSharedDocumentModel(
      { kind: "ssh", profileId: "dev" },
      "/work/file.ts",
    );
    const foreground = Symbol("foreground");
    const background = Symbol("background");
    const unsubscribe = model.subscribe(() => {});

    model.setRemotePollingActive(background, false);
    expect(model.hasRemoteSubscribers()).toBe(false);
    model.setRemotePollingActive(foreground, true);
    expect(model.hasRemoteSubscribers()).toBe(true);
    model.clearRemotePollingOwner(foreground);
    expect(model.hasRemoteSubscribers()).toBe(false);
    unsubscribe();
  });

  it("publishes one buffer and dirty state to every subscribed view", async () => {
    const first = getSharedDocumentModel(local, "C:/work/file.ts");
    const second = getSharedDocumentModel(local, "C:/work/file.ts");
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const unsubscribeFirst = first.subscribe(firstListener);
    const unsubscribeSecond = second.subscribe(secondListener);

    await vi.waitFor(() =>
      expect(first.getSnapshot().doc.status).toBe("ready"),
    );
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === "fs_read_file"),
    ).toHaveLength(1);
    first.onChange("two\n");

    expect(second.getSnapshot()).toMatchObject({
      dirty: true,
      doc: { status: "ready", content: "two\n" },
    });
    expect(firstListener).toHaveBeenCalled();
    expect(secondListener).toHaveBeenCalled();

    firstListener.mockClear();
    secondListener.mockClear();
    second.onChange("two\n");
    expect(firstListener).not.toHaveBeenCalled();
    expect(secondListener).not.toHaveBeenCalled();

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("loads one shared HEAD baseline and preserves an empty new-file baseline", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "fs_read_file") return text("new\n");
      if (command === "git_quick_diff_baseline") {
        return {
          kind: "text",
          repoRoot: "C:/work",
          relativePath: "new.ts",
          headSha: null,
          content: "",
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const model = getSharedDocumentModel(local, "C:/work/new.ts");
    const unsubscribe = model.subscribe(vi.fn());

    model.syncGitBaseline("C:/work", null);
    model.syncGitBaseline("C:/work", null);

    await vi.waitFor(() => expect(model.getSnapshot().gitBaseline).toBe(""));
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "git_quick_diff_baseline",
      ),
    ).toHaveLength(1);
    unsubscribe();
  });

  it("reloads the baseline when the repository changes at the same HEAD", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "fs_read_file") return text("current\n");
      if (command === "git_quick_diff_baseline") {
        const callCount = mocks.invoke.mock.calls.filter(
          ([name]) => name === "git_quick_diff_baseline",
        ).length;
        return {
          kind: "text",
          repoRoot: callCount === 1 ? "C:/outer" : "C:/outer/nested",
          relativePath: "file.ts",
          headSha: "same-sha",
          content: callCount === 1 ? "outer\n" : "nested\n",
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const model = getSharedDocumentModel(local, "C:/outer/nested/file.ts");
    const unsubscribe = model.subscribe(vi.fn());

    model.syncGitBaseline("C:/outer", "same-sha");
    await vi.waitFor(() =>
      expect(model.getSnapshot().gitBaseline).toBe("outer\n"),
    );
    model.syncGitBaseline("C:/outer/nested", "same-sha");
    expect(model.getSnapshot().gitBaseline).toBeNull();

    await vi.waitFor(() =>
      expect(model.getSnapshot().gitBaseline).toBe("nested\n"),
    );
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "git_quick_diff_baseline",
      ),
    ).toHaveLength(2);
    unsubscribe();
  });

  it("retries an unsupported baseline because a new worktree file can become text", async () => {
    let baselineReads = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "fs_read_file") return text("current\n");
      if (command === "git_quick_diff_baseline") {
        baselineReads += 1;
        return baselineReads === 1
          ? { kind: "unsupported" }
          : {
              kind: "text",
              repoRoot: "C:/work",
              relativePath: "new.ts",
              headSha: "head",
              content: "",
            };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const model = getSharedDocumentModel(local, "C:/work/new.ts");
    const unsubscribe = model.subscribe(vi.fn());

    model.syncGitBaseline("C:/work", "head");
    await vi.waitFor(() => expect(baselineReads).toBe(1));
    await Promise.resolve();
    model.syncGitBaseline("C:/work", "head");

    await vi.waitFor(() => expect(model.getSnapshot().gitBaseline).toBe(""));
    expect(baselineReads).toBe(2);
    unsubscribe();
  });

  it.each([false, true])(
    "discards a stale baseline after an identity or visibility change (same HEAD: %s)",
    async (sameHead) => {
      const stale = deferred<{
        kind: "text";
        repoRoot: string;
        relativePath: string;
        headSha: string;
        content: string;
      }>();
      const fresh = deferred<{
        kind: "text";
        repoRoot: string;
        relativePath: string;
        headSha: string;
        content: string;
      }>();
      mocks.invoke.mockImplementation(async (command: string) => {
        if (command === "fs_read_file") return text("current\n");
        if (command === "git_quick_diff_baseline") {
          const baselineReads = mocks.invoke.mock.calls.filter(
            ([name]) => name === "git_quick_diff_baseline",
          ).length;
          return baselineReads === 1 ? stale.promise : fresh.promise;
        }
        throw new Error(`unexpected command: ${command}`);
      });
      const model = getSharedDocumentModel(local, "C:/work/file.ts");
      const unsubscribe = model.subscribe(vi.fn());

      model.syncGitBaseline(
        sameHead ? "C:/new" : "C:/old",
        sameHead ? "new" : "old",
        "changed",
      );
      model.syncGitBaseline("C:/new", "new", "absent");
      fresh.resolve({
        kind: "text",
        repoRoot: "C:/new",
        relativePath: "file.ts",
        headSha: "new",
        content: "fresh\n",
      });
      await vi.waitFor(() =>
        expect(model.getSnapshot().gitBaseline).toBe("fresh\n"),
      );

      stale.resolve({
        kind: "text",
        repoRoot: sameHead ? "C:/new" : "C:/old",
        relativePath: "file.ts",
        headSha: sameHead ? "new" : "old",
        content: "stale\n",
      });
      await Promise.resolve();
      expect(model.getSnapshot().gitBaseline).toBe("fresh\n");
      unsubscribe();
    },
  );

  it("updates the ready document size after external formatting", async () => {
    const model = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );

    model.adoptFormattedDiskText("formatted\n", "formatted", 10, 2);

    expect(model.getSnapshot().doc).toMatchObject({
      status: "ready",
      size: 10,
    });
    unsubscribe();
  });

  it("replays a reload requested while a disk read is in flight", async () => {
    let releaseReload: (() => void) | undefined;
    let readCount = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command !== "fs_read_file") {
        throw new Error(`unexpected command: ${command}`);
      }
      readCount += 1;
      if (readCount === 2) {
        await new Promise<void>((resolve) => {
          releaseReload = resolve;
        });
      }
      return text("one\n");
    });
    const first = getSharedDocumentModel(local, "C:/work/file.ts");
    const second = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribeFirst = first.subscribe(() => {});
    const unsubscribeSecond = second.subscribe(() => {});
    await vi.waitFor(() =>
      expect(first.getSnapshot().doc.status).toBe("ready"),
    );

    first.reload();
    second.reload();
    await vi.waitFor(() => expect(releaseReload).toBeDefined());
    releaseReload?.();
    await vi.waitFor(() => expect(readCount).toBe(3));

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("reads the file only after a watcher probe finds new content", async () => {
    let readCount = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "fs_read_file") {
        readCount += 1;
        return readCount === 1
          ? text("base\n", "base", 1)
          : text("external\n", "external", 2);
      }
      if (command === "fs_file_version") {
        return { revision: "external", size: 9, mtime: 2 };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const model = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );

    model.checkForChanges();

    await vi.waitFor(() => expect(readCount).toBe(2));
    expect(model.getSnapshot()).toMatchObject({
      dirty: false,
      doc: { status: "ready", content: "external\n" },
    });
    unsubscribe();
  });

  it("ignores metadata-only external rewrites and saves without a warning", async () => {
    let readCount = 0;
    mocks.invoke.mockImplementation(
      async (command: string, args?: { content?: string }) => {
        if (command === "fs_read_file") {
          readCount += 1;
          return text("one\n", "same-content", readCount);
        }
        if (command === "fs_write_file_checked") {
          return written(args?.content ?? "");
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );
    const model = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );
    model.onChange("local\n");

    model.reload();
    await vi.waitFor(() => expect(readCount).toBe(2));
    await expect(model.save()).resolves.toBe(true);

    expect(mocks.warning).not.toHaveBeenCalled();
    expect(model.getSnapshot().dirty).toBe(false);
    unsubscribe();
  });

  it("merges an external line-ending rewrite into the local save", async () => {
    let readCount = 0;
    let writeCount = 0;
    mocks.invoke.mockImplementation(
      async (
        command: string,
        args?: {
          content?: string;
          condition?: { type?: string; version?: { revision?: string } };
        },
      ) => {
        if (command === "fs_read_file") {
          readCount += 1;
          return readCount === 1
            ? text("base\n", "base", 1)
            : text("base\r\n", "crlf-base", 2);
        }
        if (command === "fs_write_file_checked") {
          writeCount += 1;
          expect(args?.condition?.version?.revision).toBe("crlf-base");
          expect(args?.content).toBe("local\r\n");
          return written(args?.content ?? "", 3);
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );
    const model = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );
    model.onChange("local\n");

    model.reload();
    await vi.waitFor(() => expect(readCount).toBe(2));
    expect(model.getSnapshot().doc).toMatchObject({ size: 6 });
    await expect(model.save()).resolves.toBe(true);

    expect(writeCount).toBe(1);
    expect(model.getSnapshot().dirty).toBe(false);
    expect(mocks.warning).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("retains local text and enters conflict when both sides changed", async () => {
    let readCount = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command !== "fs_read_file") {
        throw new Error(`unexpected command: ${command}`);
      }
      readCount += 1;
      return readCount === 1
        ? text("base\n", "base")
        : text("external\n", "external");
    });
    const model = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );
    model.onChange("local\n");

    model.reload();
    await vi.waitFor(() => expect(mocks.warning).toHaveBeenCalledOnce());

    expect(model.getSnapshot()).toMatchObject({
      dirty: true,
      doc: { status: "ready", content: "local\n" },
    });
    expect(mocks.warning.mock.calls[0]?.[1]).toMatchObject({
      duration: Infinity,
      action: { label: "Overwrite" },
    });
    unsubscribe();
  });

  it("treats a matching external version as convergence instead of conflict", async () => {
    mocks.invoke.mockImplementation(
      async (command: string, args?: { content?: string }) => {
        if (command === "fs_read_file") return text("base\n", "base");
        if (command === "fs_write_file_checked") {
          return written(args?.content ?? "");
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );
    const model = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );
    model.onChange("local\n");

    await expect(model.save()).resolves.toBe(true);

    expect(model.getSnapshot().dirty).toBe(false);
    expect(mocks.warning).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("keeps a save conflict visible and force-writes only after confirmation", async () => {
    let readCount = 0;
    mocks.invoke.mockImplementation(
      async (
        command: string,
        args?: { content?: string; condition?: { type?: string } },
      ) => {
        if (command === "fs_read_file") {
          readCount += 1;
          return readCount === 1
            ? text("base\n", "base")
            : text("external\n", "external", 2);
        }
        if (command === "fs_write_file_checked") {
          if (args?.condition?.type === "overwrite") {
            return written(args.content ?? "", 3);
          }
          return {
            status: "conflict",
            current: observed("external\n", 2),
          };
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );
    const model = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );
    model.onChange("local\n");

    await expect(model.save()).resolves.toBe(false);
    expect(mocks.warning).toHaveBeenCalledOnce();

    mocks.warning.mock.calls[0]?.[1].action.onClick();
    await vi.waitFor(() => expect(model.getSnapshot().dirty).toBe(false));

    const writes = mocks.invoke.mock.calls.filter(
      ([command]) => command === "fs_write_file_checked",
    );
    expect(writes).toHaveLength(2);
    expect(writes[0]?.[1]).toMatchObject({
      condition: { type: "match", version: { revision: "base" } },
    });
    expect(writes[1]?.[1]).toMatchObject({
      condition: { type: "overwrite" },
    });
    expect(mocks.dismiss).toHaveBeenCalled();
    unsubscribe();
  });

  it("keeps conflict state and reports an explicit overwrite failure", async () => {
    let writeCount = 0;
    let readCount = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "fs_read_file") {
        readCount += 1;
        return readCount === 1
          ? text("base\n", "base")
          : text("external\n", "external", 2);
      }
      if (command === "fs_write_file_checked") {
        writeCount += 1;
        if (writeCount === 1) {
          return {
            status: "conflict",
            current: observed("external\n", 2),
          };
        }
        throw new Error("disk full");
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const model = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );
    model.onChange("local\n");
    await expect(model.save()).resolves.toBe(false);

    mocks.warning.mock.calls[0]?.[1].action.onClick();
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());

    expect(model.getSnapshot().dirty).toBe(true);
    expect(mocks.warning).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("treats a remotely deleted file as an overwriteable conflict", async () => {
    let readCount = 0;
    mocks.invoke.mockImplementation(
      async (command: string, args?: { condition?: { type?: string } }) => {
        if (command === "fs_read_file") {
          readCount += 1;
          if (readCount === 1) return text("base\n", "base");
          throw new Error("not found");
        }
        if (command === "fs_write_file_checked") {
          return args?.condition?.type === "overwrite"
            ? written("local\n", 3)
            : { status: "conflict", current: null };
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );
    const model = getSharedDocumentModel(
      { kind: "ssh", profileId: "dev" },
      "/work/file.ts",
    );
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );
    model.onChange("local\n");

    await expect(model.save()).resolves.toBe(false);
    expect(mocks.warning).toHaveBeenCalledOnce();

    mocks.warning.mock.calls[0]?.[1].action.onClick();
    await vi.waitFor(() => expect(model.getSnapshot().dirty).toBe(false));
    expect(mocks.dismiss).toHaveBeenCalled();
    unsubscribe();
  });

  it("coalesces concurrent saves and clears dirty for every view", async () => {
    const first = getSharedDocumentModel(local, "C:/work/file.ts");
    const second = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribeFirst = first.subscribe(() => {});
    const unsubscribeSecond = second.subscribe(() => {});
    await vi.waitFor(() =>
      expect(first.getSnapshot().doc.status).toBe("ready"),
    );
    first.onChange("shared\n");

    const [savedByFirst, savedBySecond] = await Promise.all([
      first.save(),
      second.save(),
    ]);

    expect(savedByFirst).toBe(true);
    expect(savedBySecond).toBe(true);
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "fs_write_file_checked",
      ),
    ).toHaveLength(1);
    expect(second.getSnapshot().dirty).toBe(false);
    expect(mocks.notifyDocumentSaved).toHaveBeenCalledOnce();

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("在最后一次编辑达到配置延迟后自动保存", async () => {
    usePreferencesStore.setState({
      editorAutoSave: true,
      editorAutoSaveDelay: 500,
    });
    const model = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );
    vi.useFakeTimers();

    model.onChange("first\n");
    await vi.advanceTimersByTimeAsync(400);
    model.onChange("latest\n");
    await vi.advanceTimersByTimeAsync(499);
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "fs_write_file_checked",
      ),
    ).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "fs_write_file_checked",
      ),
    ).toHaveLength(1);
    expect(model.getSnapshot().dirty).toBe(false);
    unsubscribe();
  });

  it("进入冲突后暂停自动保存", async () => {
    usePreferencesStore.setState({
      editorAutoSave: true,
      editorAutoSaveDelay: 500,
    });
    let readCount = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command !== "fs_read_file") {
        throw new Error(`unexpected command: ${command}`);
      }
      readCount += 1;
      return readCount === 1
        ? text("base\n", "base")
        : text("external\n", "external", 2);
    });
    const model = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );
    model.onChange("local\n");
    model.reload();
    await vi.waitFor(() => expect(mocks.warning).toHaveBeenCalledOnce());
    vi.useFakeTimers();

    await vi.advanceTimersByTimeAsync(500);

    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "fs_write_file_checked",
      ),
    ).toHaveLength(0);
    expect(model.getSnapshot().dirty).toBe(true);
    unsubscribe();
  });

  it("does not download an unchanged SSH conflict on every poll", async () => {
    vi.useFakeTimers();
    let readCount = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "fs_read_file") {
        readCount += 1;
        return text("base\n", "base", 1);
      }
      if (command === "fs_write_file_checked") {
        return {
          status: "conflict",
          current: observed("external\n", 2),
        };
      }
      if (command === "fs_stat") {
        return {
          kind: "file",
          size: new TextEncoder().encode("external\n").byteLength,
          mtime: 2,
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const model = getSharedDocumentModel(
      { kind: "ssh", profileId: "dev" },
      "/work/file.ts",
    );
    const unsubscribe = model.subscribe(() => {});
    const owner = Symbol("foreground");
    model.setRemotePollingActive(owner, true);
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );
    model.onChange("local\n");
    await expect(model.save()).resolves.toBe(false);
    expect(readCount).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(readCount).toBe(1);
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === "fs_stat"),
    ).toHaveLength(10);
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "fs_file_version",
      ),
    ).toHaveLength(0);
    model.clearRemotePollingOwner(owner);
    unsubscribe();
  });

  it("shares one polling timer across SSH documents", async () => {
    vi.useFakeTimers();
    const workspace = { kind: "ssh", profileId: "dev" } satisfies WorkspaceEnv;
    const first = getSharedDocumentModel(workspace, "/work/first.ts");
    const second = getSharedDocumentModel(workspace, "/work/second.ts");
    const unsubscribeFirst = first.subscribe(() => {});
    const unsubscribeSecond = second.subscribe(() => {});
    const firstOwner = Symbol("first");
    const secondOwner = Symbol("second");
    first.setRemotePollingActive(firstOwner, true);
    second.setRemotePollingActive(secondOwner, true);
    await vi.waitFor(() => {
      expect(first.getSnapshot().doc.status).toBe("ready");
      expect(second.getSnapshot().doc.status).toBe("ready");
    });

    expect(vi.getTimerCount()).toBe(1);

    first.clearRemotePollingOwner(firstOwner);
    second.clearRemotePollingOwner(secondOwner);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("periodically verifies unchanged SSH metadata with a digest", async () => {
    vi.useFakeTimers();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "fs_read_file") return text("one\n");
      if (command === "fs_stat") {
        return { kind: "file", size: 4, mtime: 1 };
      }
      if (command === "fs_file_version") {
        return { revision: "revision:one\n", size: 4, mtime: 1 };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const model = getSharedDocumentModel(
      { kind: "ssh", profileId: "dev" },
      "/work/file.ts",
    );
    const unsubscribe = model.subscribe(() => {});
    const owner = Symbol("foreground");
    model.setRemotePollingActive(owner, true);
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );

    await vi.advanceTimersByTimeAsync(30_000);

    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "fs_file_version",
      ),
    ).toHaveLength(1);
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === "fs_read_file"),
    ).toHaveLength(1);
    model.clearRemotePollingOwner(owner);
    unsubscribe();
  });

  it("关闭前立即保存已启用自动保存的脏文档", async () => {
    usePreferencesStore.setState({
      editorAutoSave: true,
      editorAutoSaveDelay: 60_000,
    });
    const model = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );
    model.onChange("save before close\n");

    await saveAutoSaveDocumentsBeforeClose();

    expect(model.getSnapshot().dirty).toBe(false);
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "fs_write_file_checked",
      ),
    ).toHaveLength(1);
    unsubscribe();
  });

  it("关闭保存期间继续编辑时会再次保存最新缓冲区", async () => {
    usePreferencesStore.setState({
      editorAutoSave: true,
      editorAutoSaveDelay: 60_000,
    });
    let releaseFirstWrite: (() => void) | undefined;
    let writeCount = 0;
    mocks.invoke.mockImplementation(
      async (command: string, args?: { content?: string }) => {
        if (command === "fs_read_file") return text("one\n");
        if (command === "fs_write_file_checked") {
          writeCount += 1;
          if (writeCount === 1) {
            await new Promise<void>((resolve) => {
              releaseFirstWrite = resolve;
            });
          }
          return written(args?.content ?? "", writeCount + 1);
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );
    const model = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );
    model.onChange("first edit\n");

    const closingSave = saveAutoSaveDocumentsBeforeClose();
    await vi.waitFor(() => expect(releaseFirstWrite).toBeDefined());
    model.onChange("latest edit\n");
    releaseFirstWrite?.();

    await expect(closingSave).resolves.toBe(true);
    expect(writeCount).toBe(2);
    expect(model.getSnapshot().dirty).toBe(false);
    unsubscribe();
  });

  it("关闭前不保存未启用自动保存的脏文档", async () => {
    const model = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );
    model.onChange("keep dirty\n");

    await saveAutoSaveDocumentsBeforeClose();

    expect(model.getSnapshot().dirty).toBe(true);
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "fs_write_file_checked",
      ),
    ).toHaveLength(0);
    unsubscribe();
  });

  it("queues the latest buffer when editing continues during a save", async () => {
    let releaseFirstWrite: (() => void) | undefined;
    let writeCount = 0;
    mocks.invoke.mockImplementation(
      async (command: string, args?: { content?: string }) => {
        if (command === "fs_read_file") return text("one\n");
        if (command === "fs_write_file_checked") {
          writeCount += 1;
          if (writeCount === 1) {
            await new Promise<void>((resolve) => {
              releaseFirstWrite = resolve;
            });
          }
          return written(args?.content ?? "", writeCount + 1);
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );
    const model = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );

    model.onChange("first edit\n");
    const firstSave = model.save();
    await vi.waitFor(() => expect(releaseFirstWrite).toBeDefined());
    model.onChange("second edit\n");
    const secondSave = model.save();
    releaseFirstWrite?.();

    await expect(firstSave).resolves.toBe(true);
    await expect(secondSave).resolves.toBe(true);
    expect(writeCount).toBe(2);
    expect(model.getSnapshot().dirty).toBe(false);
    unsubscribe();
  });

  it("probes a watcher event after saving without reading the file back", async () => {
    let releaseWrite: (() => void) | undefined;
    let readCount = 0;
    mocks.invoke.mockImplementation(
      async (command: string, args?: { content?: string }) => {
        if (command === "fs_read_file") {
          readCount += 1;
          return text("base\n", "base", 1);
        }
        if (command === "fs_write_file_checked") {
          await new Promise<void>((resolve) => {
            releaseWrite = resolve;
          });
          return written(args?.content ?? "", 2);
        }
        if (command === "fs_file_version") {
          return {
            revision: "revision:first\n",
            size: 6,
            mtime: 2,
          };
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );
    const model = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );
    model.onChange("first\n");

    const saving = model.save();
    await vi.waitFor(() => expect(releaseWrite).toBeDefined());
    model.onChange("second\n");
    model.checkForChanges();
    releaseWrite?.();

    await expect(saving).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(
        mocks.invoke.mock.calls.some(
          ([command]) => command === "fs_file_version",
        ),
      ).toBe(true),
    );
    expect(readCount).toBe(1);
    expect(model.getSnapshot()).toMatchObject({
      dirty: true,
      doc: { status: "ready", content: "second\n" },
    });
    expect(mocks.warning).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("retains an orphaned dirty buffer until it is explicitly discarded", async () => {
    const path = "C:/work/file.ts";
    const model = getSharedDocumentModel(local, path);
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );
    model.onChange("unsaved\n");

    vi.useFakeTimers();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getSharedDocumentModel(local, path)).toBe(model);
    expect(model.getSnapshot().dirty).toBe(true);

    discardSharedDocumentModel(local, path);
    expect(getSharedDocumentModel(local, path)).not.toBe(model);
  });

  it("releases an orphaned clean buffer after the grace period", async () => {
    const path = "C:/work/file.ts";
    const model = getSharedDocumentModel(local, path);
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );

    vi.useFakeTimers();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getSharedDocumentModel(local, path)).not.toBe(model);
  });
});

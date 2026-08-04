/**
 * 本文件测试文件传输前端快照的并发合并规则。
 * 锁定列表初始化不得覆盖事件监听期间收到的较新任务状态。
 */

import { describe, expect, it, vi } from "vitest";
import {
  hasExpandableTransferFailures,
  isActiveTransfer,
  type TransferTask,
} from "./types";

vi.mock("./native", () => ({ transferNative: {} }));

import {
  mergeTransferTasks,
  openTransferPanel,
  useTransferStore,
} from "./store";

function task(id: string, updatedAt: number): TransferTask {
  return {
    id,
    direction: "upload",
    strategy: "direct",
    status: "running",
    stage: "transferring",
    sourceCount: 1,
    destination: "/home/me",
    name: id,
    totalBytes: 100,
    transferredBytes: updatedAt,
    totalFiles: 1,
    completedFiles: 0,
    failedFiles: 0,
    unprocessedFiles: 0,
    totalRoots: 1,
    committedRoots: 0,
    speedBytesPerSecond: 0,
    currentFile: null,
    failure: null,
    fileFailures: [],
    conflict: null,
    isDirectory: false,
    createdAt: 1,
    updatedAt,
  };
}

describe("transfer snapshot merge", () => {
  it("keeps event snapshots newer than the initial list", () => {
    const current = { active: task("active", 20) };
    const merged = mergeTransferTasks(current, [
      task("active", 10),
      task("queued", 15),
    ]);

    expect(merged.active.updatedAt).toBe(20);
    expect(merged.queued.updatedAt).toBe(15);
  });

  it("accepts an equally recent authoritative list snapshot", () => {
    const current = { active: task("active", 20) };
    const incoming = task("active", 20);
    incoming.status = "paused";

    expect(mergeTransferTasks(current, [incoming]).active.status).toBe(
      "paused",
    );
  });

  it("does not restore tasks removed while the initial list was loading", () => {
    const current = { active: task("active", 20) };
    const incoming = [task("removed", 10), task("queued", 15)];

    const merged = mergeTransferTasks(current, incoming, new Set(["removed"]));

    expect(merged.removed).toBeUndefined();
    expect(merged.queued.updatedAt).toBe(15);
  });
});

describe("transfer panel state", () => {
  it("opens the status panel when a transfer is queued elsewhere", () => {
    useTransferStore.getState().setPanelOpen(false);

    openTransferPanel();

    expect(useTransferStore.getState().panelOpen).toBe(true);
  });

  it("removes a batch of local task snapshots in one update", () => {
    useTransferStore.setState({
      tasks: {
        first: task("first", 1),
        second: task("second", 2),
      },
    });

    useTransferStore.getState().removeLocalMany(["first", "missing"]);

    expect(useTransferStore.getState().tasks).toEqual({
      second: task("second", 2),
    });
    useTransferStore.setState({ tasks: {} });
  });
});

describe("transfer task presentation rules", () => {
  it("keeps conflict decisions active but terminal partial tasks inactive", () => {
    const waiting = task("waiting", 1);
    waiting.status = "awaiting_decision";
    expect(isActiveTransfer(waiting)).toBe(true);

    waiting.status = "completed_with_errors";
    expect(isActiveTransfer(waiting)).toBe(false);
  });

  it("expands only Direct directory failures and never Archive failures", () => {
    const partial = task("partial", 1);
    partial.status = "completed_with_errors";
    partial.isDirectory = true;
    partial.failedFiles = 1;
    partial.fileFailures = [
      {
        id: "failure",
        sourcePath: "/source/file.txt",
        destinationPath: "/target/file.txt",
        failure: {
          code: "source_changed",
          detail: "changed",
          retryable: true,
        },
        attempts: 1,
        ignored: false,
      },
    ];

    expect(hasExpandableTransferFailures(partial)).toBe(true);
    partial.strategy = "archive";
    expect(hasExpandableTransferFailures(partial)).toBe(false);
  });
});

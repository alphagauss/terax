/**
 * 本文件测试文件传输前端快照的并发合并和面板延迟展示规则。
 * 锁定初始化竞态、冲突预检、取消决策和正式执行阶段的展示边界。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasExpandableTransferFailures,
  isActiveTransfer,
  type TransferTask,
} from "./types";

vi.mock("./native", () => ({ transferNative: {} }));

import {
  mergeTransferTasks,
  requestTransferPanel,
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

beforeEach(() => {
  useTransferStore.setState({
    tasks: {},
    panelOpen: false,
    pendingPanelTaskIds: {},
  });
});

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
  it("waits through all conflict checks and opens when execution starts", () => {
    requestTransferPanel("transfer");

    const scanning = task("transfer", 1);
    scanning.stage = "scanning";
    useTransferStore.getState().upsert(scanning);
    expect(useTransferStore.getState().panelOpen).toBe(false);

    const conflict = task("transfer", 2);
    conflict.status = "awaiting_decision";
    conflict.stage = "checking_conflicts";
    useTransferStore.getState().upsert(conflict);

    const betweenConflicts = task("transfer", 3);
    betweenConflicts.stage = "checking_conflicts";
    useTransferStore.getState().upsert(betweenConflicts);
    expect(useTransferStore.getState().panelOpen).toBe(false);

    useTransferStore.getState().upsert(task("transfer", 4));
    expect(useTransferStore.getState().panelOpen).toBe(true);
    expect(useTransferStore.getState().pendingPanelTaskIds).toEqual({});
  });

  it("opens immediately when the execution event arrived before registration", () => {
    useTransferStore.setState({
      tasks: { transfer: task("transfer", 1) },
      panelOpen: false,
      pendingPanelTaskIds: {},
    });

    requestTransferPanel("transfer");

    expect(useTransferStore.getState().panelOpen).toBe(true);
  });

  it("does not open after the conflict decision cancels the transfer", () => {
    const canceled = task("transfer", 2);
    canceled.status = "canceled";
    canceled.stage = "finished";
    requestTransferPanel("transfer");

    useTransferStore.getState().upsert(canceled);

    expect(useTransferStore.getState().panelOpen).toBe(false);
    expect(useTransferStore.getState().pendingPanelTaskIds).toEqual({});
  });

  it("opens to show a task that fails during preflight", () => {
    const failed = task("transfer", 2);
    failed.status = "failed";
    failed.stage = "finished";
    requestTransferPanel("transfer");

    useTransferStore.getState().upsert(failed);

    expect(useTransferStore.getState().panelOpen).toBe(true);
    expect(useTransferStore.getState().pendingPanelTaskIds).toEqual({});
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

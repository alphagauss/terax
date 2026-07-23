/**
 * 本文件测试文件传输前端快照的并发合并规则。
 * 锁定列表初始化不得覆盖事件监听期间收到的较新任务状态。
 */

import { describe, expect, it, vi } from "vitest";
import type { TransferTask } from "./types";

vi.mock("./native", () => ({ transferNative: {} }));

import { mergeTransferTasks } from "./store";

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
    totalRoots: 1,
    committedRoots: 0,
    speedBytesPerSecond: 0,
    currentFile: null,
    failure: null,
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

    const merged = mergeTransferTasks(
      current,
      incoming,
      new Set(["removed"]),
    );

    expect(merged.removed).toBeUndefined();
    expect(merged.queued.updatedAt).toBe(15);
  });
});

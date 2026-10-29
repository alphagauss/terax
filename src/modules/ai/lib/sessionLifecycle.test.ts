/**
 * 本文件验证 AI 会话提交与切换的状态机边界。
 * 测试锁定流式生成、审批等待和运行锁期间不得提前提交。
 */

import { describe, expect, it } from "vitest";
import { shouldCommitSession } from "./sessionLifecycle";

describe("AI session commit lifecycle", () => {
  it.each(["submitted", "streaming"] as const)(
    "does not commit while %s",
    (status) => {
      expect(shouldCommitSession(status, 0, true)).toBe(false);
    },
  );

  it("keeps the run lock while an approval is pending", () => {
    expect(shouldCommitSession("ready", 1, true)).toBe(false);
  });

  it.each(["ready", "error"] as const)(
    "commits a completed dirty run in %s",
    (status) => {
      expect(shouldCommitSession(status, 0, true)).toBe(true);
    },
  );

  it("does not commit an untouched hydrated session", () => {
    expect(shouldCommitSession("ready", 0, false)).toBe(false);
  });
});

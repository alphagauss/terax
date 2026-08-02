/**
 * 本文件测试 SSH 终端退出分类与 epoch 替换规则。
 * 锁定普通 shell 退出不触发恢复，只有新的已连接 epoch 才替换 PTY。
 */

import { describe, expect, it } from "vitest";
import {
  isRecoverableRemoteExit,
  REMOTE_TRANSPORT_CLOSED_EXIT_CODE,
  shouldReplaceRemotePty,
} from "./exit";

describe("remote terminal exit classification", () => {
  it("keeps transport loss distinct from a normal bash exit", () => {
    expect(isRecoverableRemoteExit(REMOTE_TRANSPORT_CLOSED_EXIT_CODE)).toBe(
      true,
    );
    expect(isRecoverableRemoteExit(0)).toBe(false);
    expect(isRecoverableRemoteExit(143)).toBe(false);
  });

  it("replaces a remote PTY exactly once for each connected epoch", () => {
    expect(shouldReplaceRemotePty(4, null)).toBe(false);
    expect(shouldReplaceRemotePty(4, 4)).toBe(false);
    expect(shouldReplaceRemotePty(4, 5)).toBe(true);
    expect(shouldReplaceRemotePty(null, 1)).toBe(true);
  });
});

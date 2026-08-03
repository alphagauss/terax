/**
 * 本文件测试 SSH 终端退出分类与 epoch 替换规则。
 * 锁定普通 shell 退出不触发恢复，自动重连保留历史且不执行清屏复位。
 */

import { describe, expect, it } from "vitest";
import {
  EXIT_ALTERNATE_SCREEN_SEQUENCE,
  isRecoverableRemoteExit,
  REMOTE_RECONNECT_RESET_SEQUENCE,
  REMOTE_TRANSPORT_CLOSED_EXIT_CODE,
  remotePtyRespawnMode,
} from "./exit";

describe("remote terminal exit classification", () => {
  it("keeps transport loss distinct from a normal bash exit", () => {
    expect(isRecoverableRemoteExit(REMOTE_TRANSPORT_CLOSED_EXIT_CODE)).toBe(
      true,
    );
    expect(isRecoverableRemoteExit(0)).toBe(false);
    expect(isRecoverableRemoteExit(143)).toBe(false);
  });

  it("replaces a remote PTY exactly once while preserving local history", () => {
    expect(remotePtyRespawnMode(4, null)).toBeNull();
    expect(remotePtyRespawnMode(4, 4)).toBeNull();
    expect(remotePtyRespawnMode(4, 5)).toBe("preserve-history");
    expect(remotePtyRespawnMode(null, 1)).toBe("preserve-history");
  });

  it("leaves alternate screen and resets modes without erasing scrollback", () => {
    expect(EXIT_ALTERNATE_SCREEN_SEQUENCE).toBe("\x1b[?1049l");
    expect(REMOTE_RECONNECT_RESET_SEQUENCE).not.toContain("\x1b[?1049l");
    expect(REMOTE_RECONNECT_RESET_SEQUENCE).toContain("\x1b[!p");
    expect(REMOTE_RECONNECT_RESET_SEQUENCE).not.toContain("\x1bc");
    expect(REMOTE_RECONNECT_RESET_SEQUENCE).not.toContain("\x1b[2J");
    expect(REMOTE_RECONNECT_RESET_SEQUENCE).not.toContain("\x1b[3J");
  });
});

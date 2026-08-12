/**
 * 本文件测试 SSH 终端退出分类与 epoch 替换规则。
 * 锁定普通 shell 退出不触发恢复，自动重连保留历史并清理旧 PTY 的鼠标模式。
 */

import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import {
  EXIT_ALTERNATE_SCREEN_SEQUENCE,
  isRecoverableRemoteExit,
  REMOTE_RECONNECT_RESET_SEQUENCE,
  REMOTE_TRANSPORT_CLOSED_EXIT_CODE,
  remotePtyRespawnMode,
} from "./exit";

function writeTerminal(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

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
    expect(REMOTE_RECONNECT_RESET_SEQUENCE).toContain(
      "\x1b[?9;1000;1002;1003;1006;1016l",
    );
    expect(REMOTE_RECONNECT_RESET_SEQUENCE).not.toContain("\x1bc");
    expect(REMOTE_RECONNECT_RESET_SEQUENCE).not.toContain("\x1b[2J");
    expect(REMOTE_RECONNECT_RESET_SEQUENCE).not.toContain("\x1b[3J");
  });

  it.each([
    ["x10", "\x1b[?9h"],
    ["vt200", "\x1b[?1000h"],
    ["drag", "\x1b[?1002h"],
    ["any", "\x1b[?1003h"],
  ] as const)("clears stale %s mouse tracking without erasing history", async (mode, enableSequence) => {
    const term = new Terminal({ allowProposedApi: true });
    try {
      await writeTerminal(term, "history before reconnect\r\n");
      await writeTerminal(term, `${enableSequence}\x1b[?1006h`);
      expect(term.modes.mouseTrackingMode).toBe(mode);

      await writeTerminal(term, REMOTE_RECONNECT_RESET_SEQUENCE);

      expect(term.modes.mouseTrackingMode).toBe("none");
      expect(term.buffer.normal.getLine(0)?.translateToString(true)).toBe(
        "history before reconnect",
      );
    } finally {
      term.dispose();
    }
  });
});

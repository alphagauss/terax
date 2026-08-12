/**
 * 本文件测试终端命令状态注册表。
 * 锁定状态去重、创建前订阅和会话销毁后的不可用语义。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTerminalCommandState,
  setTerminalCommandState,
  subscribeTerminalCommandState,
  terminalCommandState,
  type TerminalCommandState,
} from "./commandState";

const TERMINAL_ID = 42;

afterEach(() => {
  clearTerminalCommandState(TERMINAL_ID);
});

describe("terminal command state", () => {
  it("is unavailable outside a live session", () => {
    expect(terminalCommandState(TERMINAL_ID)).toBe("unavailable");
  });

  it("notifies a pre-session subscriber only for observable changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTerminalCommandState(TERMINAL_ID, listener);

    setTerminalCommandState(TERMINAL_ID, "unknown");
    setTerminalCommandState(TERMINAL_ID, "idle");
    setTerminalCommandState(TERMINAL_ID, "idle");
    setTerminalCommandState(TERMINAL_ID, "running");

    expect(listener).toHaveBeenCalledTimes(3);
    expect(terminalCommandState(TERMINAL_ID)).toBe("running");
    unsubscribe();
  });

  it("reports unavailable before notifying session disposal", () => {
    setTerminalCommandState(TERMINAL_ID, "running");
    const observed: TerminalCommandState[] = [];
    const unsubscribe = subscribeTerminalCommandState(TERMINAL_ID, () => {
      observed.push(terminalCommandState(TERMINAL_ID));
    });

    clearTerminalCommandState(TERMINAL_ID);

    expect(observed).toEqual(["unavailable"]);
    unsubscribe();
  });
});

/**
 * 本文件测试 Alpha 前端命令封装。
 * 锁定所有窗口共享服务所使用的 IPC 命令名和参数形状，避免前后端协议漂移。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  checkAlphaPython,
  getAlphaStatus,
  restartAlpha,
  setAlphaAutoStart,
  setAlphaPythonPath,
  startAlpha,
  stopAlpha,
} from "@/modules/alpha/native";

describe("Alpha Tauri 命令封装", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("使用稳定命令查询和控制共享服务", async () => {
    await getAlphaStatus();
    await startAlpha();
    await stopAlpha();
    await restartAlpha();

    expect(mocks.invoke.mock.calls).toEqual([
      ["alpha_status"],
      ["alpha_start"],
      ["alpha_stop"],
      ["alpha_restart"],
    ]);
  });

  it("向配置命令传递显式参数对象", async () => {
    await setAlphaPythonPath("C:/Python/python.exe");
    await checkAlphaPython();
    await checkAlphaPython("C:/Python/python.exe");
    await setAlphaAutoStart(false);

    expect(mocks.invoke.mock.calls).toEqual([
      ["alpha_set_python_path", { path: "C:/Python/python.exe" }],
      ["alpha_check_python", { path: null }],
      ["alpha_check_python", { path: "C:/Python/python.exe" }],
      ["alpha_set_auto_start", { enabled: false }],
    ]);
  });
});

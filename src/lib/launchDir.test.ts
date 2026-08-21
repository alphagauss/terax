/**
 * 本文件测试 Workspace 冷启动文件的消费门槛和路径规范化。
 * 重点锁定一次性启动文件只能在 Space 与 Workbench 都恢复后读取。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { canConsumeLaunchFiles, consumeLaunchFiles } from "./launchDir";

describe("canConsumeLaunchFiles", () => {
  it("waits for both Workbench boot and Space hydration", () => {
    expect(canConsumeLaunchFiles(false, false)).toBe(false);
    expect(canConsumeLaunchFiles(true, false)).toBe(false);
    expect(canConsumeLaunchFiles(false, true)).toBe(false);
    expect(canConsumeLaunchFiles(true, true)).toBe(true);
  });
});

describe("consumeLaunchFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes Windows launch paths at the frontend boundary", async () => {
    invoke.mockResolvedValue(["C:\\repo\\README.md", "/repo/main.rs"]);

    await expect(consumeLaunchFiles()).resolves.toEqual([
      "C:/repo/README.md",
      "/repo/main.rs",
    ]);
    expect(invoke).toHaveBeenCalledWith("get_launch_files");
  });

  it("treats an unavailable launch drain as empty", async () => {
    invoke.mockRejectedValue(new Error("unavailable"));

    await expect(consumeLaunchFiles()).resolves.toEqual([]);
  });
});

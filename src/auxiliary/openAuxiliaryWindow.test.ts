/**
 * 本文件验证辅助窗口 IPC 请求保持封闭且业务页只使用统一原生命令。
 * 测试锁定设置与文件属性请求的 command 名称和序列化结构。
 */

import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { openFileProperties } from "@/modules/file-properties/openFileProperties";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAuxiliaryWindow } from "./openAuxiliaryWindow";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

describe("辅助窗口打开协议", () => {
  afterEach(() => {
    mocks.invoke.mockReset();
  });

  it("通过唯一原生命令发送封闭请求", async () => {
    await openAuxiliaryWindow({ kind: "settings", tab: "themes" });

    expect(mocks.invoke).toHaveBeenCalledWith("open_auxiliary_window", {
      request: { kind: "settings", tab: "themes" },
    });
  });

  it("设置业务入口不再调用专用原生命令", async () => {
    await openSettingsWindow("shortcuts");

    expect(mocks.invoke).toHaveBeenCalledWith("open_auxiliary_window", {
      request: { kind: "settings", tab: "shortcuts" },
    });
  });

  it("文件属性请求只携带路径和主窗口内的来源点", async () => {
    await openFileProperties("/workspace/src/main.ts", { x: 32, y: 96 });

    expect(mocks.invoke).toHaveBeenCalledWith("open_auxiliary_window", {
      request: {
        kind: "file-properties",
        path: "/workspace/src/main.ts",
        sourcePoint: { x: 32, y: 96 },
      },
    });
  });
});

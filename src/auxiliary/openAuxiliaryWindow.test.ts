/**
 * 本文件验证辅助窗口 IPC 请求保持封闭且设置页只使用统一原生命令。
 * 测试锁定 command 名称和序列化结构，避免重新引入设置页专用命令。
 */

import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
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
});

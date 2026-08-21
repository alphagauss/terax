/**
 * 本文件测试系统通知权限和失败结果。
 * 权限拒绝不得调用原生发送接口，同步异常必须收敛为可展示状态。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const notification = vi.hoisted(() => ({
  isPermissionGranted: vi.fn<() => Promise<boolean>>(),
  requestPermission: vi.fn<() => Promise<"granted" | "denied">>(),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-notification", () => notification);

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  notification.isPermissionGranted.mockResolvedValue(true);
  notification.requestPermission.mockResolvedValue("granted");
});

describe("osNotify", () => {
  it("权限可用时请求发送系统通知", async () => {
    const { osNotify } = await import("./notify");

    await expect(osNotify("标题", "正文")).resolves.toBe("requested");
    expect(notification.sendNotification).toHaveBeenCalledWith({
      title: "标题",
      body: "正文",
    });
  });

  it("权限被拒绝时不调用发送接口", async () => {
    notification.isPermissionGranted.mockResolvedValue(false);
    notification.requestPermission.mockResolvedValue("denied");
    const { osNotify } = await import("./notify");

    await expect(osNotify("标题", "正文")).resolves.toBe("denied");
    expect(notification.sendNotification).not.toHaveBeenCalled();
  });

  it("原生调用异常时返回失败并记录警告", async () => {
    notification.sendNotification.mockImplementation(() => {
      throw new Error("unavailable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { osNotify } = await import("./notify");

    await expect(osNotify("标题", "正文")).resolves.toBe("failed");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

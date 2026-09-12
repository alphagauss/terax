/**
 * 本文件测试系统通知权限和失败结果。
 * 权限拒绝不得发送，异步原生错误必须保留为可展示原因。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const notification = vi.hoisted(() => ({
  isPermissionGranted: vi.fn<() => Promise<boolean>>(),
  requestPermission: vi.fn<() => Promise<"granted" | "denied">>(),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-notification", () => notification);
vi.mock("@tauri-apps/api/core", () => ({ invoke: notification.invoke }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  notification.isPermissionGranted.mockResolvedValue(true);
  notification.requestPermission.mockResolvedValue("granted");
});

describe("osNotify", () => {
  it("权限可用时请求发送系统通知", async () => {
    const { osNotify } = await import("./notify");

    await expect(osNotify("标题", "正文")).resolves.toEqual({
      status: "requested",
    });
    expect(notification.invoke).toHaveBeenCalledWith(
      "plugin:notification|notify",
      {
        options: { title: "标题", body: "正文" },
      },
    );
  });

  it("权限被拒绝时不调用发送接口", async () => {
    notification.isPermissionGranted.mockResolvedValue(false);
    notification.requestPermission.mockResolvedValue("denied");
    const { osNotify } = await import("./notify");

    await expect(osNotify("标题", "正文")).resolves.toEqual({
      status: "denied",
    });
    expect(notification.invoke).not.toHaveBeenCalled();
  });

  it("原生调用异常时返回失败并记录警告", async () => {
    notification.invoke.mockRejectedValue(new Error("unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { osNotify } = await import("./notify");

    await expect(osNotify("标题", "正文")).resolves.toEqual({
      status: "failed",
      error: "unavailable",
    });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("权限检查失败时保留具体原因，且不发送", async () => {
    notification.isPermissionGranted.mockRejectedValue(
      "permission check unavailable",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { prepareOsNotification } = await import("./notify");
    await expect(prepareOsNotification()).resolves.toEqual({
      status: "failed",
      error: "permission check unavailable",
    });
    expect(notification.invoke).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("重新检查权限，允许系统设置撤销授权", async () => {
    const { osNotify } = await import("./notify");
    await osNotify("标题", "正文");
    notification.isPermissionGranted.mockResolvedValue(false);
    notification.requestPermission.mockResolvedValue("denied");
    await expect(osNotify("标题", "正文")).resolves.toEqual({
      status: "denied",
    });
    expect(notification.invoke).toHaveBeenCalledTimes(1);
  });
});

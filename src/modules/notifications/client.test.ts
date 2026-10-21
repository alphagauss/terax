/**
 * 验证统一通知 IPC 的权限、目标透传和原生错误结果。
 */
import { beforeEach, expect, it, vi } from "vitest";
import {
  osNotify,
  prepareOsNotification,
  sendOsNotification,
  type NotificationTarget,
} from "./client";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
const { isFocused } = vi.hoisted(() => ({ isFocused: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused }),
}));
const target: NotificationTarget = {
  window: "main",
  target: { module: "terminal", tabId: 7 },
};
beforeEach(() => {
  vi.resetAllMocks();
  invoke.mockResolvedValue(true);
  isFocused.mockResolvedValue(false);
});
it("前台误报为后台时不请求权限或系统通知", async () => {
  isFocused.mockResolvedValue(true);
  await expect(osNotify("标题", "正文", target)).resolves.toEqual({
    status: "suppressed",
  });
  expect(invoke).not.toHaveBeenCalled();
});
it("权限等待期间切回前台时取消系统通知", async () => {
  invoke.mockImplementation(async () => {
    isFocused.mockResolvedValue(true);
    return true;
  });
  await expect(osNotify("标题", "正文", target)).resolves.toEqual({
    status: "suppressed",
  });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("notification_prepare");
});
it("设置中的直接发送不受前台抑制影响", async () => {
  isFocused.mockResolvedValue(true);
  await expect(sendOsNotification("标题", "正文", target)).resolves.toEqual({
    status: "requested",
  });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("notification_send", {
    request: { title: "标题", body: "正文", target },
  });
});
it("准备权限后将模块目标交给原生服务", async () => {
  await expect(osNotify("标题", "正文", target)).resolves.toEqual({
    status: "requested",
  });
  expect(invoke.mock.calls).toEqual([
    ["notification_prepare"],
    ["notification_send", { request: { title: "标题", body: "正文", target } }],
  ]);
});
it("权限拒绝时不发送", async () => {
  invoke.mockResolvedValue(false);
  await expect(osNotify("标题", "正文", target)).resolves.toEqual({
    status: "denied",
  });
  expect(invoke).toHaveBeenCalledOnce();
});
it("保留异步原生发送错误", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  invoke
    .mockResolvedValueOnce(true)
    .mockRejectedValueOnce("native send failed");
  await expect(osNotify("标题", "正文", target)).resolves.toEqual({
    status: "failed",
    error: "native send failed",
  });
  warn.mockRestore();
});
it("保留权限错误", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  invoke.mockRejectedValue(new Error("permission unavailable"));
  await expect(prepareOsNotification()).resolves.toEqual({
    status: "failed",
    error: "permission unavailable",
  });
  warn.mockRestore();
});

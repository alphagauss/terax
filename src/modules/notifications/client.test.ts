/**
 * 验证统一通知 IPC 的权限、目标透传和原生错误结果。
 */
import { beforeEach, expect, it, vi } from "vitest";
import {
  osNotify,
  prepareOsNotification,
  type NotificationTarget,
} from "./client";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const target: NotificationTarget = {
  window: "main",
  target: { module: "terminal", tabId: 7 },
};
beforeEach(() => {
  vi.resetAllMocks();
  invoke.mockResolvedValue(true);
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

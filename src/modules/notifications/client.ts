/**
 * 本文件提供主窗口、辅助窗口与业务模块共用的系统通知协议。
 * 保留具体错误，并等待原生发送结果；请求成功不代表系统已展示通知。
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AuxiliaryWindowOpenRequest } from "@/auxiliary/openAuxiliaryWindow";

export type MainNotificationTarget =
  | { module: "workspace" }
  | { module: "terminal"; tabId: number }
  | { module: "ai"; sessionId: string };

export type NotificationTarget =
  | { window: "main"; target: MainNotificationTarget }
  | { window: "auxiliary"; request: AuxiliaryWindowOpenRequest };

type NotificationFailure = { status: "failed"; error: string };
export type OsNotificationResult =
  | { status: "requested" | "denied" }
  | NotificationFailure;

function failed(error: unknown): NotificationFailure {
  console.warn("[terax] os notification failed:", error);
  return {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  };
}

/** 在倒计时前处理权限；每次重新检查，以反映用户修改的系统设置。 */
export async function prepareOsNotification(): Promise<
  { status: "ready" | "denied" } | NotificationFailure
> {
  try {
    const granted = await invoke<boolean>("notification_prepare");
    return { status: granted ? "ready" : "denied" };
  } catch (error) {
    return failed(error);
  }
}

/** 发送到本进程所属的窗口和模块，并等待原生发送 API 返回。 */
export async function sendOsNotification(
  title: string,
  body: string,
  target: NotificationTarget,
): Promise<OsNotificationResult> {
  try {
    await invoke("notification_send", { request: { title, body, target } });
    return { status: "requested" };
  } catch (error) {
    return failed(error);
  }
}

/** 业务通知仅在后台投递；权限等待后再次检查，避免切回前台仍弹系统通知。 */
export async function osNotify(
  title: string,
  body: string,
  target: NotificationTarget,
): Promise<OsNotificationResult | { status: "suppressed" }> {
  try {
    if (await getCurrentWindow().isFocused()) return { status: "suppressed" };
  } catch (error) {
    return failed(error);
  }
  const permission = await prepareOsNotification();
  if (permission.status === "failed") return permission;
  if (permission.status === "denied") return { status: "denied" };
  try {
    if (await getCurrentWindow().isFocused()) return { status: "suppressed" };
  } catch (error) {
    return failed(error);
  }
  return sendOsNotification(title, body, target);
}

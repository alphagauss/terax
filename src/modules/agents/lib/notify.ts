/**
 * 本文件封装 Tauri 系统通知权限检查和投递结果。
 * 保留具体错误，并等待原生发送结果；请求成功不代表系统已展示通知。
 */

import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";

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
    const granted =
      (await isPermissionGranted()) ||
      (await requestPermission()) === "granted";
    return { status: granted ? "ready" : "denied" };
  } catch (error) {
    return failed(error);
  }
}

/** 权限准备完成后发送通知，直接等待插件 IPC，捕获异步原生错误。 */
export async function sendOsNotification(
  title: string,
  body: string,
): Promise<OsNotificationResult> {
  try {
    await invoke("plugin:notification|notify", { options: { title, body } });
    return { status: "requested" };
  } catch (error) {
    return failed(error);
  }
}

/** 为业务通知串联权限检查和原生投递。 */
export async function osNotify(
  title: string,
  body: string,
): Promise<OsNotificationResult> {
  const permission = await prepareOsNotification();
  if (permission.status === "failed") return permission;
  if (permission.status === "denied") return { status: "denied" };
  return sendOsNotification(title, body);
}

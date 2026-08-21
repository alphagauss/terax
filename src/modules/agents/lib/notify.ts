/**
 * 本文件封装 Tauri 系统通知权限检查和投递结果。
 * 只缓存已授予状态，拒绝或失败后仍允许用户修改系统设置并再次尝试。
 */

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export type OsNotificationResult = "requested" | "denied" | "failed";

let granted = false;

async function ensurePermission(): Promise<boolean> {
  // 只缓存成功结果，使系统设置中的后续授权可以在下一次尝试时生效。
  if (granted) return true;
  let ok = await isPermissionGranted();
  if (!ok) ok = (await requestPermission()) === "granted";
  granted = ok;
  return ok;
}

/** 请求发送系统通知，并区分权限拒绝与调用失败。 */
export async function osNotify(
  title: string,
  body: string,
): Promise<OsNotificationResult> {
  try {
    if (!(await ensurePermission())) return "denied";
    sendNotification({ title, body });
    return "requested";
  } catch (e) {
    console.warn("[terax] os notification failed:", e);
    return "failed";
  }
}

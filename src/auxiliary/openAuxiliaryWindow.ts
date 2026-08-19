/**
 * 本文件定义辅助窗口前端打开协议和统一 Tauri 调用。
 * 请求使用封闭联合类型，业务调用方不能指定原生 URL、label 或权限。
 */

import type { SettingsTab } from "@/modules/settings/openSettingsWindow";
import { invoke } from "@tauri-apps/api/core";

export const AUXILIARY_OPEN_EVENT = "terax:auxiliary-open";

export type AuxiliaryWindowSourcePoint = {
  x: number;
  y: number;
};

export type AuxiliaryWindowOpenRequest =
  | {
      kind: "settings";
      tab?: SettingsTab;
    }
  | {
      kind: "file-properties";
      path: string;
      sourcePoint?: AuxiliaryWindowSourcePoint;
    };

export type AuxiliaryWindowOpenEnvelope = {
  revision: number;
  request: AuxiliaryWindowOpenRequest;
};

/** 调用原生层打开或复用一个已注册的辅助窗口。 */
export async function openAuxiliaryWindow(
  request: AuxiliaryWindowOpenRequest,
): Promise<void> {
  await invoke("open_auxiliary_window", { request });
}

/** 读取当前辅助窗口最近一次经过原生层验证的打开请求。 */
export async function getAuxiliaryWindowRequest(): Promise<AuxiliaryWindowOpenEnvelope> {
  return invoke<AuxiliaryWindowOpenEnvelope>("get_auxiliary_window_request");
}

/**
 * 本文件提供文件属性辅助窗口的业务打开入口。
 * 来源点只描述主 WebView 内的右键位置，最终定位由原生窗口定义决定。
 */

import {
  openAuxiliaryWindow,
  type AuxiliaryWindowSourcePoint,
} from "@/auxiliary/openAuxiliaryWindow";

/** 打开或复用当前 Workspace 的文件属性窗口。 */
export async function openFileProperties(
  path: string,
  sourcePoint?: AuxiliaryWindowSourcePoint,
): Promise<void> {
  await openAuxiliaryWindow({
    kind: "file-properties",
    path,
    ...(sourcePoint ? { sourcePoint } : {}),
  });
}

/**
 * 本文件集中处理交给系统应用打开的外部链接。
 * 仅允许封闭协议集合，不处理工作区文件、相对路径或 WebView 内部导航。
 */

import { openUrl } from "@tauri-apps/plugin-opener";

const EXTERNAL_URL_PATTERN = /^(?:https?:|mailto:|tel:)/i;

/** 判断链接是否使用允许交给系统应用的外部协议。 */
export function isExternalUrl(href: string): boolean {
  return EXTERNAL_URL_PATTERN.test(href);
}

/**
 * 通过 Tauri 原生 opener 打开受信协议链接。
 *
 * 不支持的协议直接拒绝；打开失败只记录错误。两条路径都会执行收尾回调，
 * 便于终端等输入控件恢复焦点。
 */
export function openExternalUrl(
  href: string,
  onSettled?: () => void,
): Promise<void> {
  if (!isExternalUrl(href)) {
    onSettled?.();
    return Promise.resolve();
  }

  return openUrl(href)
    .catch((error) => {
      console.error("[terax] failed to open external link:", error);
    })
    .finally(() => onSettled?.());
}

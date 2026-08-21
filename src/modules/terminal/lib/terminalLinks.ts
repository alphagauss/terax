/**
 * 本文件为 xterm OSC 8 链接创建原生打开处理器。
 * 链接协议由共享外链策略校验，打开结束后恢复当前终端焦点。
 */

import { openExternalUrl } from "@/lib/external-link";

/** 创建使用延迟绑定焦点回调的 xterm 链接处理器。 */
export function createTerminalLinkHandler(focus: () => void) {
  return {
    activate: (_event: MouseEvent, uri: string) =>
      void openExternalUrl(uri, focus),
  };
}

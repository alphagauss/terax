/** Windows 使用 WebView2 原生拖动区域；其他平台保留 Tauri 的平台拖窗实现。 */

import { IS_WINDOWS } from "@/lib/platform";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export const WINDOW_DRAG_REGION = IS_WINDOWS
  ? { "data-native-window-drag-region": true }
  : { "data-tauri-drag-region": true };

/** 原生标题栏不派发 DOM 右键事件，将窗口客户区物理坐标还原到现有业务菜单。 */
export async function installWindowChrome(): Promise<() => void> {
  if (!IS_WINDOWS) return () => {};
  let disposed = false;
  const unlisten = await getCurrentWebviewWindow().listen<{
    x: number;
    y: number;
  }>("window-chrome-context-menu", ({ payload }) => {
    if (disposed) return;
    const x = payload.x / window.devicePixelRatio;
    const y = payload.y / window.devicePixelRatio;
    const target = document.elementFromPoint(x, y);
    // 异步通知到达时可能已展开弹层，不将旧标题栏事件转交给新的交互目标。
    if (!target?.hasAttribute("data-native-window-drag-region")) return;
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: x,
        clientY: y,
      }),
    );
  });
  return () => {
    disposed = true;
    unlisten();
  };
}

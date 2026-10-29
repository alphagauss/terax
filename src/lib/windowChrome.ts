/** Windows 使用 WebView2 原生拖动区域；其他平台保留 Tauri 的平台拖窗实现。 */

import { IS_WINDOWS } from "@/lib/platform";

export const WINDOW_DRAG_REGION = IS_WINDOWS
  ? { "data-native-window-drag-region": true }
  : { "data-tauri-drag-region": true };

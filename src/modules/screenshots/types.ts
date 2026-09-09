/** 截图页面与原生运行时之间的受控协议，不包含文件路径或可执行窗口位置。 */
export interface ScreenshotConfig {
  globalShortcutEnabled: boolean;
  shortcut: string;
}

export interface ScreenshotStatus {
  globalShortcutOwner: boolean;
  config: ScreenshotConfig;
  registered: boolean;
  error: string | null;
}

export interface ScreenshotFrame {
  token: string;
  width: number;
  height: number;
  language: "en" | "zh-CN";
}

export const SCREENSHOT_EVENT = "terax:screenshot-changed";

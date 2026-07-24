/**
 * 本文件在 Workspace 启动数据就绪后挂载 Terax 主应用，并显示完成初始化的窗口。
 * WSL 与 SSH 可由原生端提前显示冷启动占位，本地窗口保持隐藏直至主应用挂载。
 */

import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";
import "./i18n";
import { preloadEn, preloadZhCN } from "./i18n";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { initLaunchDir } from "./lib/launchDir";
import { USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";
import { initializeWorkspaceProcess } from "./modules/workspace-process";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

// Render-instrumentation overlay, opt-in: `VITE_REACT_SCAN=true pnpm dev`.
// Dev-only dynamic import so it never reaches the production bundle.
if (import.meta.env.DEV && import.meta.env.VITE_REACT_SCAN === "true") {
  const { scan } = await import("react-scan");
  scan({ enabled: true });
}

await initializeWorkspaceProcess();

// Reap PTY sessions orphaned by a prior webview load before any tab spawns.
await invoke("pty_close_all").catch(() => {});

// Seed before first paint so default tab mounts at target cwd (no flicker).
await initLaunchDir();

// Preload panel en locale bundles in the background (non-blocking).
void preloadEn();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);

const preloadChinese = () => void preloadZhCN().catch(() => {});
if ("requestIdleCallback" in window) {
  window.requestIdleCallback(preloadChinese, { timeout: 1500 });
} else {
  setTimeout(preloadChinese, 0);
}

// 隐藏窗口中的 rAF 可能被限流，使用短定时器确保本地窗口在主应用挂载后显示。
const showWindow = () => {
  getCurrentWindow()
    .show()
    .catch((error) => console.error("window.show failed:", error));
};
setTimeout(showWindow, 50);
// 幂等兜底，避免个别平台首次调用成功但窗口尚未真正显示。
setTimeout(showWindow, 500);

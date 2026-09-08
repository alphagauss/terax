/**
 * 本文件是所有轻量辅助窗口的统一前端入口。
 * 它在窗口显示前加载主题、读取原生能力并按受控 label 懒加载业务页面。
 */

import "@/lib/developmentPerformance";
import {
  AuxiliaryWindowErrorBoundary,
  AuxiliaryWindowUnavailablePage,
} from "@/auxiliary/AuxiliaryWindowErrorBoundary";
import {
  type AuxiliaryWindowCapabilities,
  AuxiliaryWindowProvider,
} from "@/auxiliary/AuxiliaryWindowContext";
import { loadAuxiliaryWindowPage } from "@/auxiliary/registry";
import { preloadEn, preloadZhCN } from "@/i18n";
import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { ThemeProvider } from "@/modules/theme";
import "@/styles/globals.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

void preloadEn();

/** 在窗口仍隐藏时读取原生按钮能力，失败时采用只允许关闭的安全回退。 */
async function readWindowCapabilities(): Promise<AuxiliaryWindowCapabilities> {
  const nativeWindow = getCurrentWindow();
  try {
    const [minimizable, maximizable] = await Promise.all([
      nativeWindow.isMinimizable(),
      nativeWindow.isMaximizable(),
    ]);
    return { minimizable, maximizable };
  } catch (error) {
    console.error("读取辅助窗口能力失败", error);
    return { minimizable: false, maximizable: false };
  }
}

/** 挂载当前 label 对应的辅助页面，并将加载错误交给公共回退界面。 */
async function mountAuxiliaryWindow(): Promise<void> {
  const nativeWindow = getCurrentWindow();
  const capabilities = await readWindowCapabilities();
  let Page: React.ComponentType | null = null;

  try {
    Page = await loadAuxiliaryWindowPage(nativeWindow.label);
  } catch (error) {
    console.error("加载辅助窗口页面失败", error);
  }

  ReactDOM.createRoot(
    document.getElementById("auxiliary-root") as HTMLElement,
  ).render(
    <ThemeProvider>
      <AuxiliaryWindowProvider capabilities={capabilities}>
        <AuxiliaryWindowErrorBoundary>
          {Page ? <Page /> : <AuxiliaryWindowUnavailablePage />}
        </AuxiliaryWindowErrorBoundary>
      </AuxiliaryWindowProvider>
    </ThemeProvider>,
  );
}

void mountAuxiliaryWindow();

const preloadChinese = () => void preloadZhCN().catch(() => {});
if ("requestIdleCallback" in window) {
  window.requestIdleCallback(preloadChinese, { timeout: 1500 });
} else {
  setTimeout(preloadChinese, 0);
}

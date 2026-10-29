/**
 * 本文件管理禅模式与原生窗口全屏状态之间的临时会话。
 * 禅模式不持久化，并在退出时恢复进入前的全屏状态与页面焦点。
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

type UseZenModeOptions = {
  onFullscreenError: (error: unknown) => void;
  focusWorkbench: () => void;
};

const ZEN_HIDDEN_FOCUS_SELECTOR = [
  "[data-sidebar-drop-location]",
  "[data-sidebar-drop-zone]",
  "[data-workbench-tab-bar]",
  "[data-tauri-drag-region]",
  "[data-native-window-drag-region]",
  "footer",
].join(",");

/**
 * 控制可重复切换的禅模式，并同步用户从系统层退出全屏的行为。
 * 快速连续切换会串行收敛到最后一次请求，避免原生窗口状态反转。
 */
export function useZenMode({
  onFullscreenError,
  focusWorkbench,
}: UseZenModeOptions) {
  const [enabled, setEnabled] = useState(false);
  const enabledRef = useRef(false);
  const desiredRef = useRef(false);
  const reconcilingRef = useRef(false);
  const fullscreenExpectedRef = useRef(false);
  const restoreFullscreenRef = useRef(true);
  const changedFullscreenRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const movedFocusRef = useRef(false);

  const reconcile = useCallback(async () => {
    if (reconcilingRef.current) return;
    reconcilingRef.current = true;
    const window = getCurrentWindow();

    try {
      while (enabledRef.current !== desiredRef.current) {
        if (desiredRef.current) {
          const returnFocus =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          returnFocusRef.current = returnFocus;
          movedFocusRef.current =
            returnFocus?.closest(ZEN_HIDDEN_FOCUS_SELECTOR) != null;
          enabledRef.current = true;
          setEnabled(true);
          if (movedFocusRef.current) requestAnimationFrame(focusWorkbench);

          try {
            const wasFullscreen = await window.isFullscreen();
            changedFullscreenRef.current = false;
            fullscreenExpectedRef.current = wasFullscreen;
            if (!wasFullscreen) {
              await invoke("set_fullscreen", { fullscreen: true });
              changedFullscreenRef.current = true;
              fullscreenExpectedRef.current = true;
            }
          } catch (error) {
            fullscreenExpectedRef.current = false;
            onFullscreenError(error);
          }
          continue;
        }

        fullscreenExpectedRef.current = false;
        if (restoreFullscreenRef.current && changedFullscreenRef.current) {
          try {
            await invoke("set_fullscreen", { fullscreen: false });
          } catch (error) {
            onFullscreenError(error);
          }
        }
        enabledRef.current = false;
        setEnabled(false);
        restoreFullscreenRef.current = true;
        changedFullscreenRef.current = false;
        requestAnimationFrame(() => {
          const returnFocus = returnFocusRef.current;
          // 已隐藏外壳中的旧控件不再代表用户当前上下文，避免 F10 退出后产生悬空焦点环。
          if (movedFocusRef.current) focusWorkbench();
          else if (returnFocus?.isConnected) returnFocus.focus();
          movedFocusRef.current = false;
        });
      }
    } finally {
      reconcilingRef.current = false;
    }
  }, [focusWorkbench, onFullscreenError]);

  const toggle = useCallback(() => {
    desiredRef.current = !desiredRef.current;
    restoreFullscreenRef.current = true;
    void reconcile();
  }, [reconcile]);

  useEffect(() => {
    const window = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void window
      .onResized(async () => {
        if (disposed || !enabledRef.current || !fullscreenExpectedRef.current) {
          return;
        }
        try {
          if (await window.isFullscreen()) return;
          restoreFullscreenRef.current = false;
          desiredRef.current = false;
          await reconcile();
        } catch (error) {
          onFullscreenError(error);
        }
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((error) => {
        if (!disposed) onFullscreenError(error);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onFullscreenError, reconcile]);

  return { enabled, toggle } as const;
}

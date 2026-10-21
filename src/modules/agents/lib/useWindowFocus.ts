import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

/** 使用原生窗口焦点，避免 WebView 内部焦点变化被误判为应用退到后台。 */
export function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(() =>
    typeof document !== "undefined" ? document.hasFocus() : true,
  );

  useEffect(() => {
    let alive = true;
    let focusChanged = false;
    let unlisten: (() => void) | undefined;
    const window = getCurrentWindow();
    window
      .onFocusChanged(({ payload }) => {
        focusChanged = true;
        if (alive) setFocused(payload);
      })
      .then(async (u) => {
        if (!alive) {
          u();
          return;
        }
        unlisten = u;
        const initialFocus = await window.isFocused();
        // 查询期间的新事件优先，不能用较旧的查询结果覆盖。
        if (alive && !focusChanged) setFocused(initialFocus);
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return focused;
}

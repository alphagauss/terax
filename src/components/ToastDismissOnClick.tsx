/**
 * 为 Sonner Toast 提供点击通知主体关闭的交互。
 * 通过触发现有关闭按钮复用 Sonner 的退出动画和清理逻辑，不处理按钮上的操作点击。
 */

import { useEffect } from "react";

/**
 * 监听 Toast 主体点击并触发 Sonner 的原生关闭流程。
 * 操作按钮、关闭按钮和表单控件的点击会交给 Toast 自身处理，避免阻断原有行为。
 */
export function ToastDismissOnClick() {
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;

      const target = event.target;
      if (target.closest("button, a, input, textarea, select, [data-button]")) {
        return;
      }

      const toast = target.closest<HTMLElement>("[data-sonner-toast]");
      toast?.querySelector<HTMLButtonElement>("[data-close-button]")?.click();
    };

    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  return null;
}

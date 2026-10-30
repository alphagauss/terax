/** 错误浮层关闭后返回有效操作位置，保留用户主动选择的外部焦点。 */
function canFocus(element: HTMLElement | null): element is HTMLElement {
  return (
    !!element?.isConnected &&
    !element.matches(":disabled") &&
    !element.closest(
      '[hidden], [inert], [aria-hidden="true"], [data-state="closed"]:is([role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"])',
    ) &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden"
  );
}

/** 自动聚焦不滚动页面；输入框的编辑边框独立于导航焦点提示。 */
function focusSilently(element: HTMLElement | null | undefined) {
  const target = element ?? null;
  if (!canFocus(target)) return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
}

export type FocusReturn = {
  target: HTMLElement | null;
  fallback: HTMLElement | null;
};

/** 在发起操作时保存返回位置；局部容器和活动页负责目标失效后的回退。 */
export function captureFocusReturn(
  target: Element | null = document.activeElement,
): FocusReturn {
  const element = target instanceof HTMLElement ? target : null;
  const fallback =
    element?.closest<HTMLElement>(
      '[data-focus-scope], [role="dialog"], [role="alertdialog"]',
    ) ??
    document.querySelector<HTMLElement>("[data-focus-scope]:not([hidden])") ??
    document.querySelector<HTMLElement>("#root");
  return { target: element, fallback };
}

/** 退出展示后恢复焦点；较晚完成的操作不覆盖用户已选择的其他有效目标。 */
export function restoreFocus(
  point: FocusReturn | null,
  closingLayer?: HTMLElement | null,
) {
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    active !== document.body &&
    active !== point?.target &&
    active !== point?.fallback &&
    canFocus(active) &&
    !closingLayer?.contains(active)
  )
    return;
  if (focusSilently(point?.target) || focusSilently(point?.fallback)) return;
  // 目标所属页已隐藏时，只回退到当前有效作用域，不唤醒旧页面。
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"]',
    ),
  );
  const fallback =
    dialogs.reverse().find(canFocus) ??
    document.querySelector<HTMLElement>("[data-focus-scope]:not([hidden])") ??
    document.querySelector<HTMLElement>("#root");
  focusSilently(fallback);
}

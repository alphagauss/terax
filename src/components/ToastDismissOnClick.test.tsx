// @vitest-environment happy-dom

/**
 * 本文件测试 Toast 主体点击关闭的交互不变量。
 * 重点锁定操作按钮不被主体关闭监听拦截，普通主体点击会复用关闭按钮。
 */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastDismissOnClick } from "./ToastDismissOnClick";

describe("ToastDismissOnClick", () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  it("closes a toast when its body is clicked", async () => {
    const onClose = vi.fn();
    container = document.createElement("div");
    container.innerHTML =
      '<div data-sonner-toast><span>Message</span><button data-close-button>Close</button></div>';
    document.body.append(container);
    container.querySelector("[data-close-button]")?.addEventListener("click", onClose);
    root = createRoot(document.createElement("div"));

    await act(async () => {
      root?.render(createElement(ToastDismissOnClick));
    });
    container.querySelector("span")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not intercept action button clicks", async () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    container = document.createElement("div");
    container.innerHTML =
      '<div data-sonner-toast><button data-button>Open</button><button data-close-button>Close</button></div>';
    document.body.append(container);
    container.querySelector("[data-button]")?.addEventListener("click", onAction);
    container.querySelector("[data-close-button]")?.addEventListener("click", onClose);
    root = createRoot(document.createElement("div"));

    await act(async () => {
      root?.render(createElement(ToastDismissOnClick));
    });
    container.querySelector("[data-button]")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onAction).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });
});

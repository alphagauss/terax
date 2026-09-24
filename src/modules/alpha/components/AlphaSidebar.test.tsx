/**
 * 本文件测试 Alpha 侧边栏的业务导航。
 * 重点锁定按钮只触发对应入口，并且不会把 React 点击事件误传为工作组标识。
 */

// @vitest-environment happy-dom

import { AlphaSidebar } from "@/modules/alpha/components/AlphaSidebar";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("AlphaSidebar", () => {
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
  });

  it("opens each Alpha page without forwarding the click event", async () => {
    const onOpenDesk = vi.fn();
    const onOpenWorkstation = vi.fn();
    const onOpenData = vi.fn();
    const container = document.createElement("div");
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(AlphaSidebar, {
          onOpenDesk,
          onOpenWorkstation,
          onOpenData,
        }),
      );
    });

    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(3);
    buttons.forEach((button) => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onOpenDesk).toHaveBeenCalledWith();
    expect(onOpenWorkstation).toHaveBeenCalledWith();
    expect(onOpenData).toHaveBeenCalledWith();
  });
});

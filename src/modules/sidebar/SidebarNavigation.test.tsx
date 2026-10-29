// @vitest-environment happy-dom

import { SidebarActivityBar } from "@/modules/sidebar/SidebarNavigation";
import { getSidebarContainer } from "@/modules/sidebar/containers";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["default", "top", "bottom"] as const)(
  "%s 活动栏空白处不响应标题栏操作，普通右键打开配置菜单",
  async (position) => {
    const onToggleVisibility = vi.fn();
    const onActivate = vi.fn();
    const onMove = vi.fn();
    const container = getSidebarContainer("explorer");
    const containers = [container, getSidebarContainer("search")];
    await act(async () =>
      root.render(
        <SidebarActivityBar
          activityBar={{ position, size: "default", hiddenContainerIds: [] }}
          containers={containers}
          allContainers={[container]}
          activeId={null}
          onActivate={onActivate}
          onMove={onMove}
          onReset={vi.fn()}
          onToggleVisibility={onToggleVisibility}
          onPositionChange={vi.fn()}
          onSizeChange={vi.fn()}
        />,
      ),
    );
    expect(
      host.querySelector(
        "[data-native-window-drag-region], [data-tauri-drag-region]",
      ),
    ).toBeNull();
    const button = host.querySelector<HTMLButtonElement>(
      '[data-sidebar-container-button="explorer"]',
    );
    if (!button) throw new Error("活动栏图标未挂载");
    await act(async () => button.click());
    expect(onActivate).toHaveBeenCalledWith("explorer");
    const bar = host.querySelector<HTMLElement>("[data-sidebar-drop-location]");
    if (!bar) throw new Error("活动栏未挂载");
    vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 200, 200),
    );
    host
      .querySelectorAll<HTMLElement>("[data-sidebar-container-id]")
      .forEach((item, index) => {
        vi.spyOn(item, "getBoundingClientRect").mockReturnValue(
          new DOMRect(index * 40, index * 40, 40, 40),
        );
      });
    button.setPointerCapture = vi.fn();
    for (const [type, coordinate] of [
      ["pointerdown", 10],
      ["pointermove", 90],
      ["pointerup", 90],
    ] as const) {
      await act(async () =>
        button.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 1,
            button: 0,
            clientX: coordinate,
            clientY: coordinate,
          }),
        ),
      );
    }
    expect(onMove).toHaveBeenCalledExactlyOnceWith("explorer", "primary", 1);
    const viewport = host.querySelector<HTMLElement>(
      "[data-sidebar-navigation-viewport]",
    );
    if (!viewport) throw new Error("活动栏视口未挂载");
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: 20,
      clientY: 300,
    });
    await act(async () => viewport.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain("activityBarPosition");
    const visibility = menu?.querySelector<HTMLElement>(
      '[role="menuitemcheckbox"]',
    );
    if (!visibility) throw new Error("活动栏可见性菜单未挂载");
    await act(async () => visibility.click());
    expect(onToggleVisibility).toHaveBeenCalledWith("explorer");
  },
);

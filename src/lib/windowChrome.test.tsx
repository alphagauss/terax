// @vitest-environment happy-dom

import { installWindowChrome } from "@/lib/windowChrome";
import { SidebarActivityBar } from "@/modules/sidebar/SidebarNavigation";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  windows: true,
  unlisten: vi.fn(),
  listen: vi.fn(),
  contextMenu: undefined as
    | undefined
    | ((event: { payload: { x: number; y: number } }) => void),
}));
vi.mock("@/lib/platform", () => ({
  get IS_WINDOWS() {
    return native.windows;
  },
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen: native.listen }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let root: Root;
let host: HTMLDivElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.windows = true;
  native.unlisten.mockReset();
  native.listen.mockReset().mockImplementation(async (_name, handler) => {
    native.contextMenu = handler;
    return native.unlisten;
  });
  native.contextMenu = undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  dispose?.();
  dispose = undefined;
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderBar(position: "default" | "top") {
  dispose = await installWindowChrome();
  await act(async () =>
    root.render(
      <SidebarActivityBar
        activityBar={{ position, size: "default", hiddenContainerIds: [] }}
        containers={[]}
        allContainers={[]}
        activeId={null}
        onActivate={vi.fn()}
        onMove={vi.fn()}
        onReset={vi.fn()}
        onToggleVisibility={vi.fn()}
        onPositionChange={vi.fn()}
        onSizeChange={vi.fn()}
      />,
    ),
  );
  const viewport = host.querySelector<HTMLElement>(
    "[data-sidebar-navigation-viewport]",
  );
  if (!viewport) throw new Error("活动栏视口未挂载");
  return viewport;
}

it.each(["default", "top"] as const)(
  "Windows %s 活动栏移除异步拖窗入口，原生右键仍打开原有配置菜单",
  async (position) => {
    const viewport = await renderBar(position);
    expect(host.querySelector("[data-tauri-drag-region]")).toBeNull();
    expect(viewport.hasAttribute("data-native-window-drag-region")).toBe(true);
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(1.5);
    const hitTest = vi
      .spyOn(document, "elementFromPoint")
      .mockReturnValue(viewport);
    let event: MouseEvent | undefined;
    viewport.addEventListener("contextmenu", (value) => {
      event = value;
    });
    await act(async () => native.contextMenu?.({ payload: { x: 90, y: 150 } }));
    expect(hitTest).toHaveBeenCalledWith(60, 100);
    expect(event?.clientX).toBe(60);
    expect(event?.clientY).toBe(100);
    expect(event?.defaultPrevented).toBe(true);
    expect(document.querySelector('[role="menu"]')?.textContent).toContain(
      "activityBarPosition",
    );
  },
);

it("延迟的原生右键不能落到后来出现的按钮或弹层上，卸载后也不再派发", async () => {
  const viewport = await renderBar("default");
  const button = document.createElement("button");
  viewport.append(button);
  const received = vi.fn();
  viewport.addEventListener("contextmenu", received);
  const hitTest = vi
    .spyOn(document, "elementFromPoint")
    .mockReturnValue(button);
  native.contextMenu?.({ payload: { x: 30, y: 40 } });
  expect(received).not.toHaveBeenCalled();
  hitTest.mockReturnValue(viewport);
  dispose?.();
  dispose = undefined;
  native.contextMenu?.({ payload: { x: 30, y: 40 } });
  expect(native.unlisten).toHaveBeenCalledOnce();
  expect(received).not.toHaveBeenCalled();
});

it("非 Windows 不安装原生消息桥接", async () => {
  native.windows = false;
  dispose = await installWindowChrome();
  expect(native.listen).not.toHaveBeenCalled();
});

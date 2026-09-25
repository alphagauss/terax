// @vitest-environment happy-dom

import type { WorkbenchState } from "@/modules/workbench/types";
import type { WorkbenchViewServices } from "@/modules/workbench/viewRegistry";
import {
  useWorkbenchOverlayContainer,
  WorkbenchPageDialog,
  WorkbenchPageScope,
  WorkbenchPageWindow,
} from "@/modules/workbench/WorkbenchPageOverlays";
import { WorkbenchViewPool } from "@/modules/workbench/WorkbenchViewPool";
import { act, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/modules/workbench/viewRegistry", () => ({
  WorkbenchRegisteredView: () => <TestPage />,
}));

function Draft() {
  useEffect(() => {
    lifecycle.mount();
    return () => lifecycle.unmount();
  }, []);
  return <input aria-label="draft" defaultValue="initial" />;
}

function TestPage() {
  const [dialog, setDialog] = useState(false);
  const [window, setWindow] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setDialog(true)}>
        edit
      </button>
      <WorkbenchPageWindow open={window} onOpenChange={setWindow} title="Tools">
        <Draft />
      </WorkbenchPageWindow>
      <WorkbenchPageDialog open={dialog} onOpenChange={setDialog} title="Edit">
        <Draft />
      </WorkbenchPageDialog>
    </>
  );
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const environment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
beforeEach(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  lifecycle.mount.mockClear();
  lifecycle.unmount.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  environment.IS_REACT_ACT_ENVIRONMENT = false;
});
const click = async (element: HTMLElement) =>
  act(async () => {
    element.focus();
    element.click();
  });
function find<T extends HTMLElement = HTMLElement>(
  selector: string,
  parent: ParentNode = container,
): T {
  const element = parent.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}
const pressEscape = async (element: HTMLElement) =>
  act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
const waitForExit = async () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
  });

it("遮罩关闭须显式启用，只响应可见顶层遮罩的主键操作", async () => {
  const close = vi.fn();
  const closeWindow = vi.fn();
  const render = async (
    dismissOnBackdrop: boolean,
    visible = true,
    blocked = false,
  ) =>
    act(async () =>
      root.render(
        <>
          <button type="button" data-navigation="">
            other page
          </button>
          <WorkbenchPageScope visible={visible} focused={visible}>
            <WorkbenchPageWindow open onOpenChange={closeWindow} title="tools">
              tools
            </WorkbenchPageWindow>
            <WorkbenchPageDialog
              open
              onOpenChange={close}
              title="dialog"
              dismissOnBackdrop={dismissOnBackdrop}
            >
              <input />
            </WorkbenchPageDialog>
            <WorkbenchPageDialog
              open={blocked}
              onOpenChange={() => {}}
              title="top"
            >
              top
            </WorkbenchPageDialog>
          </WorkbenchPageScope>
        </>,
      ),
    );
  const down = async (element: HTMLElement, button = 0) =>
    act(async () => {
      element.dispatchEvent(
        new PointerEvent("pointerdown", {
          button,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  await render(false);
  const backdrop = find("[data-workbench-page-backdrop]");
  await down(backdrop);
  expect(close).not.toHaveBeenCalled();
  await render(true);
  await down(find("[data-navigation]"));
  await down(find("input"));
  await act(async () => {
    backdrop.dispatchEvent(
      new PointerEvent("pointerup", { button: 0, bubbles: true }),
    );
  });
  await down(backdrop, 2);
  expect(close).not.toHaveBeenCalled();
  await render(true, false);
  await down(backdrop);
  expect(close).not.toHaveBeenCalled();
  await render(true, true, true);
  await down(backdrop);
  expect(close).not.toHaveBeenCalled();
  await render(true);
  await down(backdrop);
  expect(close).toHaveBeenCalledExactlyOnceWith(false);
  expect(closeWindow).not.toHaveBeenCalled();
});

it("页内模态只隔离本页，后台保留草稿且不响应其他页面的 Escape", async () => {
  const render = async (visible: boolean) =>
    act(async () =>
      root.render(
        <>
          <button type="button" data-navigation="">
            another tab
          </button>
          <WorkbenchPageScope visible={visible} focused={visible}>
            <TestPage />
          </WorkbenchPageScope>
        </>,
      ),
    );
  await render(true);
  const edit = find<HTMLButtonElement>("[data-workbench-page-scope] button");
  await click(edit);
  const dialog = find('[data-workbench-page-overlay="dialog"]');
  const floating = find('[data-workbench-page-overlay="window"]');
  const input = find<HTMLInputElement>("input", dialog);
  input.value = "unsaved";
  expect(floating.inert).toBe(true);
  expect(edit.closest("[inert]")).not.toBeNull();
  expect(document.body.style.pointerEvents).toBe("");
  expect(document.body.style.overflow).toBe("");
  const navigation = find<HTMLButtonElement>("[data-navigation]");
  expect(navigation.closest("[inert]")).toBeNull();
  await click(navigation);
  await render(false);
  await pressEscape(navigation);
  expect(dialog.isConnected).toBe(true);
  expect(dialog.inert).toBe(true);
  expect(document.activeElement).toBe(navigation);
  await render(true);
  expect(dialog.querySelector("input")).toBe(input);
  expect(input.value).toBe("unsaved");
  expect(lifecycle.mount).toHaveBeenCalledTimes(2);
  expect(lifecycle.unmount).not.toHaveBeenCalled();
  await pressEscape(input);
  expect(dialog.dataset.state).toBe("closed");
  expect(dialog.inert).toBe(true);
  expect(floating.inert).toBe(false);
  expect(edit.closest("[inert]")).toBeNull();
  expect(document.activeElement).toBe(edit);
  await waitForExit();
  expect(dialog.isConnected).toBe(false);
});

it("非模态浮窗不锁定页面，多个模态按打开顺序恢复且 Tab 保留在顶层", async () => {
  function Nested() {
    const [second, setSecond] = useState(false);
    return (
      <WorkbenchPageDialog open onOpenChange={() => {}} title="first">
        <button type="button" data-nested="" onClick={() => setSecond(true)}>
          nested
        </button>
        <WorkbenchPageDialog
          open={second}
          onOpenChange={setSecond}
          title="second"
        >
          <input />
        </WorkbenchPageDialog>
      </WorkbenchPageDialog>
    );
  }
  await act(async () =>
    root.render(
      <WorkbenchPageScope visible focused>
        <TestPage />
      </WorkbenchPageScope>,
    ),
  );
  expect(
    container
      .querySelector("[data-workbench-page-scope] button")
      ?.closest("[inert]"),
  ).toBeNull();
  await act(async () =>
    root.render(
      <WorkbenchPageScope visible focused>
        <Nested />
      </WorkbenchPageScope>,
    ),
  );
  const trigger = find<HTMLButtonElement>("[data-nested]");
  await click(trigger);
  const dialogs = container.querySelectorAll<HTMLElement>(
    '[data-workbench-page-overlay="dialog"]',
  );
  expect(dialogs[0].inert).toBe(true);
  expect(dialogs[1].inert).toBe(false);
  const input = find<HTMLInputElement>("input", dialogs[1]);
  await act(async () => {
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(document.activeElement).toBe(dialogs[1].querySelector("button"));
  await pressEscape(input);
  expect(dialogs[1].dataset.state).toBe("closed");
  expect(dialogs[0].inert).toBe(false);
  expect(document.activeElement).toBe(trigger);
  await waitForExit();
  expect(
    container.querySelectorAll('[data-workbench-page-overlay="dialog"]'),
  ).toHaveLength(1);
});

it("退出期间重新打开复用原浮层，并取消旧卸载计时", async () => {
  const render = async (open: boolean) =>
    act(async () =>
      root.render(
        <WorkbenchPageScope visible focused>
          <WorkbenchPageDialog open={open} title="edit" onOpenChange={() => {}}>
            <Draft />
          </WorkbenchPageDialog>
        </WorkbenchPageScope>,
      ),
    );
  await render(true);
  const dialog = find('[data-workbench-page-overlay="dialog"]');
  const input = find<HTMLInputElement>("input", dialog);
  input.value = "retained";
  await render(false);
  expect(dialog.dataset.state).toBe("closed");
  expect(dialog.inert).toBe(true);
  await render(true);
  expect(find('[data-workbench-page-overlay="dialog"]')).toBe(dialog);
  expect(dialog.inert).toBe(false);
  await waitForExit();
  expect(dialog.isConnected).toBe(true);
  expect(input.value).toBe("retained");
  await render(false);
  await waitForExit();
  expect(dialog.isConnected).toBe(false);
});

it("页面实例池跨标签、Space 和分组移动保留浮层宿主，关页才释放", async () => {
  const tab = {
    id: 1,
    kind: "terminal" as const,
    spaceId: "a",
    title: "Test",
  };
  const services = { onFocusTab: vi.fn() } as unknown as WorkbenchViewServices;
  const render = async (
    activeSpaceId: string,
    groupId: number,
    activeTabId: number | null,
    closed = false,
  ) => {
    const state: WorkbenchState = {
      tabs: closed ? {} : { 1: tab },
      spaces: {
        a: {
          root: { kind: "group", id: groupId, groupId },
          activeGroupId: groupId,
          groups: {
            [groupId]: { id: groupId, tabIds: closed ? [] : [1], activeTabId },
          },
        },
      },
    };
    await act(async () =>
      root.render(
        <>
          <div key={groupId} data-workbench-view-host={groupId} />
          <WorkbenchViewPool
            state={state}
            tabs={Object.values(state.tabs)}
            activeSpaceId={activeSpaceId}
            services={services}
          />
        </>,
      ),
    );
  };
  await render("a", 10, 1);
  const host = container.querySelector("[data-workbench-overlay-host]");
  const input = find<HTMLInputElement>("input");
  input.value = "retained";
  await render("a", 10, null);
  expect(
    input.closest<HTMLElement>("[data-workbench-page-scope]")?.style.visibility,
  ).toBe("hidden");
  await render("b", 10, 1);
  await render("a", 20, 1);
  expect(container.querySelector("[data-workbench-overlay-host]")).toBe(host);
  expect(
    input
      .closest("[data-workbench-view-host]")
      ?.getAttribute("data-workbench-view-host"),
  ).toBe("20");
  expect(input.value).toBe("retained");
  expect(lifecycle.mount).toHaveBeenCalledTimes(1);
  expect(lifecycle.unmount).not.toHaveBeenCalled();
  await render("a", 20, null, true);
  expect(host?.isConnected).toBe(false);
  expect(lifecycle.unmount).toHaveBeenCalledTimes(1);
});

it("分屏的模态相互独立，子 Portal 留在所属层，后台关闭不抢焦点", async () => {
  function ChildPortal() {
    const target = useWorkbenchOverlayContainer();
    return target
      ? createPortal(
          <button type="button" data-child-portal="">
            child
          </button>,
          target,
        )
      : null;
  }
  const render = async (leftOpen: boolean, leftFocused: boolean) =>
    act(async () =>
      root.render(
        <>
          <section data-pane="left">
            <WorkbenchPageScope visible focused={leftFocused}>
              <WorkbenchPageDialog
                open={leftOpen}
                onOpenChange={() => {}}
                title="left"
              >
                <ChildPortal />
              </WorkbenchPageDialog>
            </WorkbenchPageScope>
          </section>
          <section data-pane="right">
            <WorkbenchPageScope visible focused={!leftFocused}>
              <WorkbenchPageDialog open onOpenChange={() => {}} title="right">
                <input />
              </WorkbenchPageDialog>
            </WorkbenchPageScope>
          </section>
        </>,
      ),
    );
  await render(true, true);
  const child = find<HTMLButtonElement>("[data-child-portal]");
  expect(child.closest("[data-pane]")?.getAttribute("data-pane")).toBe("left");
  expect(child.closest("[inert]")).toBeNull();
  const rightInput = find<HTMLInputElement>('[data-pane="right"] input');
  expect(rightInput.closest("[inert]")).toBeNull();
  await render(true, false);
  await act(async () => rightInput.focus());
  await render(false, false);
  expect(document.activeElement).toBe(rightInput);
});

it("同步打开嵌套模态时子层仍位于父层上方", async () => {
  await act(async () =>
    root.render(
      <WorkbenchPageScope visible focused>
        <WorkbenchPageDialog open title="parent" onOpenChange={() => {}}>
          <WorkbenchPageDialog open title="child" onOpenChange={() => {}}>
            <input data-child="" />
          </WorkbenchPageDialog>
        </WorkbenchPageDialog>
      </WorkbenchPageScope>,
    ),
  );
  const child = find("[data-child]");
  expect(child.closest("[inert]")).toBeNull();
  const layers = container.querySelectorAll<HTMLElement>(
    "[data-workbench-page-overlay]",
  );
  const parent = [...layers].find((layer) => !layer.contains(child));
  expect(parent?.inert).toBe(true);
});

it("用户已转向宿主工具栏时异步关闭浮层不归还旧焦点", async () => {
  function Page({ open }: { open: boolean }) {
    return (
      <>
        <button type="button" data-opener="">
          open
        </button>
        <WorkbenchPageWindow open={open} title="tools" onOpenChange={() => {}}>
          <input />
        </WorkbenchPageWindow>
      </>
    );
  }
  const render = async (open: boolean) =>
    act(async () =>
      root.render(
        <>
          <button type="button" data-toolbar="">
            toolbar
          </button>
          <WorkbenchPageScope visible focused>
            <Page open={open} />
          </WorkbenchPageScope>
        </>,
      ),
    );
  await render(false);
  await act(async () => find("[data-opener]").focus());
  await render(true);
  const toolbar = find("[data-toolbar]");
  await act(async () => toolbar.focus());
  await render(false);
  expect(document.activeElement).toBe(toolbar);
});

it("恢复模态焦点时跳过已禁用控件，Tab 不进入隐藏父容器的内容", async () => {
  const render = async (visible: boolean, disabled: boolean) =>
    act(async () =>
      root.render(
        <WorkbenchPageScope visible={visible} focused={visible}>
          <WorkbenchPageDialog open title="edit" onOpenChange={() => {}}>
            <input data-field="" disabled={disabled} />
            <div style={{ display: "none" }}>
              <input data-hidden-field="" />
            </div>
          </WorkbenchPageDialog>
        </WorkbenchPageScope>,
      ),
    );
  await render(true, false);
  const field = find("[data-field]");
  await act(async () => field.focus());
  await render(false, true);
  await render(true, true);
  const close = find("[role=dialog] button");
  expect(document.activeElement).toBe(close);
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  });
  await act(async () => close.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(close);
});

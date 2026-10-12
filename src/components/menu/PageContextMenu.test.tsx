// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PageContextMenu } from "@/components/menu/PageContextMenu";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/menu/context-menu";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/controls/dialog";

const mocks = vi.hoisted(() => ({
  text: vi.fn(),
  html: vi.fn(),
  image: vi.fn(),
  save: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/clipboard", () => ({
  writeClipboardText: mocks.text,
  writeClipboardHtml: mocks.html,
}));
vi.mock("@/lib/imageActions", () => ({
  writeClipboardImage: mocks.image,
  saveImageAs: mocks.save,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.success },
}));
vi.mock("@/lib/errors", () => ({ reportError: mocks.error }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(mocks))
    mock.mockReset().mockResolvedValue(undefined);
  window.getSelection()?.removeAllRanges();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function open(target: Element) {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: 30,
    clientY: 40,
  });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}
async function choose(label: string) {
  const item = Array.from(
    document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((element) => element.textContent === label);
  expect(item).toBeDefined();
  await act(async () => {
    item?.click();
  });
  // Radix 在关闭后的下一轮事件恢复焦点，再模拟下一次用户操作。
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

it("菜单保存打开时的选区，焦点或选区改变后仍复制原内容", async () => {
  await act(async () =>
    root.render(
      <>
        <PageContextMenu />
        <p>
          <strong>原内容</strong>
        </p>
        <p>其他内容</p>
      </>,
    ),
  );
  const strong = container.querySelector("strong") as HTMLElement;
  const range = document.createRange();
  range.selectNodeContents(strong);
  window.getSelection()?.addRange(range);
  expect((await open(strong)).defaultPrevented).toBe(true);
  window.getSelection()?.removeAllRanges();
  await choose("copy");
  expect(mocks.html).toHaveBeenCalledWith(
    "<p><strong>原内容</strong></p>",
    "原内容",
  );
  expect(mocks.success).toHaveBeenCalledWith("copied");
});

it("已有业务菜单优先，不出现第二套菜单", async () => {
  await act(async () =>
    root.render(
      <>
        <PageContextMenu />
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <a href="https://example.com">业务链接</a>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>业务动作</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </>,
    ),
  );
  await open(container.querySelector("a") as HTMLElement);
  expect(
    Array.from(document.querySelectorAll('[role="menuitem"]')).map(
      (item) => item.textContent,
    ),
  ).toEqual(["业务动作"]);
});

it("输入框、编辑器保留原菜单，普通空白区域不显示菜单", async () => {
  await act(async () =>
    root.render(
      <>
        <PageContextMenu />
        <input />
        <div className="cm-editor">编辑器</div>
        <p>空白</p>
      </>,
    ),
  );
  expect(
    (await open(container.querySelector("input") as HTMLElement))
      .defaultPrevented,
  ).toBe(false);
  expect(
    (await open(container.querySelector(".cm-editor") as HTMLElement))
      .defaultPrevented,
  ).toBe(false);
  expect(
    (await open(container.querySelector("p") as HTMLElement)).defaultPrevented,
  ).toBe(true);
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it("跨编辑区域的混合选区保留原菜单", async () => {
  await act(async () =>
    root.render(
      <>
        <PageContextMenu />
        <section>
          <p>正文</p>
          <div contentEditable suppressContentEditableWarning>
            编辑区
          </div>
        </section>
      </>,
    ),
  );
  const section = container.querySelector("section") as HTMLElement;
  const range = document.createRange();
  range.selectNodeContents(section);
  window.getSelection()?.addRange(range);
  expect((await open(section)).defaultPrevented).toBe(false);
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it("链接保存完整地址，图片来源变化时不复制替换后的图片", async () => {
  await act(async () =>
    root.render(
      <>
        <PageContextMenu />
        <a href="https://example.com/original">
          <img src="/original.png" alt="图片" />
        </a>
      </>,
    ),
  );
  const image = container.querySelector("img") as HTMLImageElement;
  Object.defineProperties(image, {
    complete: { value: true },
    naturalWidth: { value: 10 },
  });
  await open(image);
  (container.querySelector("a") as HTMLAnchorElement).href =
    "https://example.com/changed";
  await choose("pageMenu.copyLink");
  expect(mocks.text).toHaveBeenCalledWith("https://example.com/original");
  await open(image);
  await choose("pageMenu.copyImage");
  expect(mocks.image).toHaveBeenCalledWith(image);
  mocks.image.mockClear();
  await open(image);
  image.src = "/changed.png";
  await choose("pageMenu.copyImage");
  expect(mocks.image).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledWith("pageMenu.copyFailed", {
    error: expect.objectContaining({ message: "image changed" }),
  });
});

it("菜单归属当前弹窗或错误浮层，Esc 和点击外部只关闭菜单", async () => {
  const dialogChanged = vi.fn();
  await act(async () =>
    root.render(
      <>
        <PageContextMenu />
        <Dialog open onOpenChange={dialogChanged}>
          <DialogContent>
            <DialogTitle>测试</DialogTitle>
            <DialogDescription>菜单</DialogDescription>
            <a href="https://example.com">链接</a>
            <div data-error-host>
              <a href="https://example.com/error">错误链接</a>
            </div>
            <button type="button">外部按钮</button>
          </DialogContent>
        </Dialog>
      </>,
    ),
  );
  const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
  const link = dialog.querySelector("a") as HTMLElement;
  await act(async () => link.focus());
  await open(link);
  const menu = document.querySelector('[role="menu"]') as HTMLElement;
  expect(dialog.contains(menu)).toBe(true);
  await act(async () => {
    menu.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(dialogChanged).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.activeElement).toBe(link));
  await open(link);
  await act(async () => {
    dialog.querySelector("button")?.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerType: "mouse",
        button: 0,
      }),
    );
  });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  const errorLink = dialog.querySelector<HTMLElement>("[data-error-host] a");
  if (!errorLink) throw new Error("缺少错误详情链接");
  await open(errorLink);
  expect(
    document.querySelector('[role="menu"]')?.closest("[data-error-host]"),
  ).not.toBeNull();
});

it.each([true, false, "failed"])(
  "图片另存为使用打开时的来源，正确处理结果：%s",
  async (result) => {
    await act(async () =>
      root.render(
        <>
          <PageContextMenu />
          <img src="/original.gif" alt="图片" />
        </>,
      ),
    );
    const image = container.querySelector("img") as HTMLImageElement;
    const source = image.src;
    await open(image);
    image.src = "/changed.png";
    if (result === "failed")
      mocks.save.mockRejectedValueOnce(new Error("save failed"));
    else mocks.save.mockResolvedValueOnce(result);
    await choose("pageMenu.saveImage");
    expect(mocks.save).toHaveBeenCalledWith(source, {
      title: "pageMenu.saveImage",
      imageFilter: "pageMenu.imageFilter",
    });
    if (result === true)
      expect(mocks.success).toHaveBeenCalledWith("pageMenu.saved");
    else expect(mocks.success).not.toHaveBeenCalled();
    if (result === "failed")
      expect(mocks.error).toHaveBeenCalledWith("pageMenu.saveFailed", {
        error: expect.objectContaining({ message: "save failed" }),
      });
    else expect(mocks.error).not.toHaveBeenCalled();
  },
);

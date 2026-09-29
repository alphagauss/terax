// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSelectionClipboard } from "@/lib/selectionClipboard";

const mocks = vi.hoisted(() => ({ windows: true, write: vi.fn() }));
vi.mock("@/lib/platform", () => ({
  get IS_WINDOWS() {
    return mocks.windows;
  },
}));
vi.mock("@/lib/clipboard", () => ({ writeClipboardHtml: mocks.write }));

let dispose: () => void;
beforeEach(() => {
  mocks.windows = true;
  mocks.write.mockReset().mockResolvedValue(undefined);
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});
afterEach(() => {
  dispose?.();
  vi.restoreAllMocks();
});

function select(node: Node, start?: number, end?: number) {
  const range = document.createRange();
  if (start !== undefined && end !== undefined) {
    range.setStart(node, start);
    range.setEnd(node, end);
  } else range.selectNodeContents(node);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

function copy(target: EventTarget = document) {
  const event = new Event("copy", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("Windows 页面选区复制", () => {
  it("部分粗体选区只复制选中的文字，同时保留外层 HTML", () => {
    document.body.innerHTML = "<p>前缀<strong>选中文字</strong>后缀</p>";
    const strong = document.querySelector("strong") as HTMLElement;
    select(strong.firstChild as Text, 1, 3);
    dispose = installSelectionClipboard();
    expect(copy(strong).defaultPrevented).toBe(true);
    expect(mocks.write).toHaveBeenCalledWith(
      "<p><strong>中文</strong></p>",
      "中文",
    );
  });

  it("表格选区保留表格结构，不复制未选中的旁边文字", () => {
    document.body.innerHTML =
      "<p>不复制</p><table><tbody><tr><td><b>内容</b></td></tr></tbody></table>";
    const table = document.querySelector("table") as HTMLElement;
    select(table);
    dispose = installSelectionClipboard();
    copy(table);
    expect(mocks.write).toHaveBeenCalledWith(table.outerHTML, "内容");
  });

  it("不把应用的固定定位和布局外壳带入粘贴内容", () => {
    document.body.innerHTML =
      '<div id="root" style="position:fixed;width:1200px"><div class="flex"><p><strong>正文</strong></p></div></div>';
    const strong = document.querySelector("strong") as HTMLElement;
    select(strong.firstChild as Text, 0, 2);
    dispose = installSelectionClipboard();
    copy(strong);
    expect(mocks.write).toHaveBeenCalledWith(
      "<p><strong>正文</strong></p>",
      "正文",
    );
  });

  it("仍保留选区外层的行内文字样式", () => {
    document.body.innerHTML = '<div><span style="color:red">正文</span></div>';
    const span = document.querySelector("span") as HTMLElement;
    select(span.firstChild as Text, 0, 2);
    dispose = installSelectionClipboard();
    copy(span);
    expect(mocks.write).toHaveBeenCalledWith(span.outerHTML, "正文");
  });

  it("跨过编辑区域的混合选区仍由浏览器处理", () => {
    document.body.innerHTML =
      '<p>开始</p><div contenteditable="true">编辑区</div><p>结束</p>';
    select(document.body);
    dispose = installSelectionClipboard();
    expect(copy().defaultPrevented).toBe(false);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it.each([
    "input",
    "textarea",
    "div contenteditable='true'",
    "div class='cm-editor'",
    "div class='xterm'",
  ])("不接管 %s 的复制", (tag) => {
    document.body.innerHTML = `<${tag}>输入内容</${tag.split(" ")[0]}>`;
    const element = document.body.firstElementChild as HTMLElement;
    select(element);
    dispose = installSelectionClipboard();
    expect(copy(element).defaultPrevented).toBe(false);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("组件已处理的复制、空选区和键盘中断不触发原生写入", () => {
    document.body.innerHTML = "<p>选区</p>";
    const paragraph = document.querySelector("p") as HTMLElement;
    select(paragraph);
    paragraph.addEventListener("copy", (event) => event.preventDefault());
    dispose = installSelectionClipboard();
    copy(paragraph);
    window.getSelection()?.removeAllRanges();
    expect(copy().defaultPrevented).toBe(false);
    const key = new KeyboardEvent("keydown", {
      key: "c",
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    document.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("卸载或非 Windows 环境保留浏览器默认行为", () => {
    document.body.innerHTML = "<p>选区</p>";
    select(document.body.firstChild as Node);
    dispose = installSelectionClipboard();
    dispose();
    expect(copy().defaultPrevented).toBe(false);
    mocks.windows = false;
    dispose = installSelectionClipboard();
    expect(copy().defaultPrevented).toBe(false);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("原生写入失败被处理，不重放浏览器复制", async () => {
    document.body.innerHTML = "<p>选区</p>";
    select(document.body.firstChild as Node);
    const error = new Error("clipboard busy");
    mocks.write.mockRejectedValueOnce(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    dispose = installSelectionClipboard();
    expect(copy().defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(log).toHaveBeenCalledWith("复制页面选区失败", error);
    expect(mocks.write).toHaveBeenCalledOnce();
  });
});

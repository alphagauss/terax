/** Windows 主窗口的普通页面选区复制；保留 HTML，不接管编辑器、终端或图片专用菜单。 */
import { writeClipboardHtml } from "@/lib/clipboard";
import { IS_WINDOWS } from "@/lib/platform";

const EDITABLE =
  "input, textarea, [contenteditable]:not([contenteditable='false']), .cm-editor, .xterm";
const FORMATTING_CONTEXT =
  "a, b, blockquote, code, del, em, h1, h2, h3, h4, h5, h6, i, ins, kbd, li, mark, ol, p, pre, s, small, span, strong, sub, sup, table, tbody, td, tfoot, th, thead, tr, u, ul";

/** 监听复制事件而非快捷键，让页面 Ctrl+C 与浏览器的选区复制共用原生写入。 */
export function installSelectionClipboard(): () => void {
  if (!IS_WINDOWS) return () => {};

  const onCopy = (event: ClipboardEvent) => {
    if (event.defaultPrevented) return;
    if (event.target instanceof Element && event.target.closest(EDITABLE))
      return;
    const selection = window.getSelection();
    const text = selection?.toString();
    if (!selection || selection.isCollapsed || !text) return;

    const html = document.createElement("div");
    for (let index = 0; index < selection.rangeCount; index++) {
      const range = selection.getRangeAt(index);
      const ancestor = range.commonAncestorContainer;
      let parent =
        ancestor instanceof Element ? ancestor : ancestor.parentElement;
      if (parent?.closest(EDITABLE)) return;
      const fragment = range.cloneContents();
      if (fragment.querySelector(EDITABLE)) return;
      let content: Node = fragment;
      // 仅补齐 strong、table 等格式祖先，不把应用的定位和布局外壳带入剪贴板。
      while (
        parent &&
        parent !== document.body &&
        parent !== document.documentElement
      ) {
        if (parent.matches(FORMATTING_CONTEXT)) {
          const wrapper = parent.cloneNode(false);
          wrapper.appendChild(content);
          content = wrapper;
        }
        parent = parent.parentElement;
      }
      html.appendChild(content);
    }

    event.preventDefault();
    void writeClipboardHtml(html.innerHTML, text).catch((error) => {
      console.error("复制页面选区失败", error);
    });
  };
  document.addEventListener("copy", onCopy);
  return () => document.removeEventListener("copy", onCopy);
}

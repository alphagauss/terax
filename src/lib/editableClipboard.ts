/** Windows 编辑区域复制适配；复用编辑器最终数据，不改动剪切、粘贴与撤销。 */
import { writeClipboardText } from "@/lib/clipboard";
import { IS_WINDOWS } from "@/lib/platform";

/** 在编辑器处理完事件后接管写入，保留 CodeMirror 的整行复制与多选区状态。 */
export function installEditableClipboard(): () => void {
  if (!IS_WINDOWS) return () => {};
  const onCopy = (event: ClipboardEvent) => {
    if (!event.cancelable || !(event.target instanceof Element)) return;
    const editor = event.target.closest(".cm-editor");
    const input = event.target.closest("input, textarea");
    let text: string;
    if (editor) {
      const data = event.clipboardData;
      // 未处理的事件或附带其他格式时，保留组件自己的复制协议。
      if (
        !event.defaultPrevented ||
        !data ||
        data.types.length !== 1 ||
        data.types[0] !== "text/plain"
      )
        return;
      text = data.getData("text/plain");
    } else if (
      (input instanceof HTMLInputElement ||
        input instanceof HTMLTextAreaElement) &&
      !event.defaultPrevented &&
      input.type !== "password"
    ) {
      const { selectionStart: start, selectionEnd: end } = input;
      if (start === null || end === null || start === end) return;
      text = input.value.slice(start, end);
    } else return;

    event.preventDefault();
    // 已取消的事件仍可能写入 DataTransfer，清空它以避免随后覆盖原生写入。
    event.clipboardData?.clearData();
    void writeClipboardText(text).catch((error) =>
      console.error("复制编辑区域失败", error),
    );
  };
  window.addEventListener("copy", onCopy);
  return () => window.removeEventListener("copy", onCopy);
}

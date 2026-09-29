// @vitest-environment happy-dom
import { EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installEditableClipboard } from "@/lib/editableClipboard";

const mocks = vi.hoisted(() => ({ windows: true, write: vi.fn() }));
vi.mock("@/lib/platform", () => ({
  get IS_WINDOWS() {
    return mocks.windows;
  },
}));
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: mocks.write }));
let dispose: () => void;
let view: EditorView | undefined;
beforeEach(() => {
  mocks.windows = true;
  mocks.write.mockReset().mockResolvedValue(undefined);
  document.body.innerHTML = "";
  dispose = installEditableClipboard();
});
afterEach(() => {
  dispose();
  view?.destroy();
  view = undefined;
  vi.restoreAllMocks();
});

function event(type = "copy", data = new DataTransfer()) {
  const value = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(value, "clipboardData", { value: data });
  return value;
}

it.each(["input", "textarea"])(
  "%s 只复制实际选区，空选区、剪切、粘贴不接管",
  (tag) => {
    const input = document.createElement(tag) as HTMLInputElement;
    document.body.append(input);
    input.value = "前缀正文后缀";
    input.setSelectionRange(2, 4);
    const copy = event();
    input.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(true);
    expect(mocks.write).toHaveBeenCalledWith("正文");
    mocks.write.mockClear();
    input.setSelectionRange(0, 0);
    for (const type of ["copy", "cut", "paste"]) {
      const other = event(type);
      input.dispatchEvent(other);
      expect(other.defaultPrevented).toBe(false);
    }
    expect(mocks.write).not.toHaveBeenCalled();
  },
);

it("密码、组件已处理事件、非 Windows 与卸载后不接管", () => {
  const input = document.createElement("input");
  document.body.append(input);
  input.type = "password";
  input.value = "secret";
  input.select();
  expect(input.dispatchEvent(event())).toBe(true);
  input.type = "text";
  input.select();
  const handled = event();
  handled.preventDefault();
  input.dispatchEvent(handled);
  dispose();
  mocks.windows = false;
  dispose = installEditableClipboard();
  expect(input.dispatchEvent(event())).toBe(true);
  dispose();
  expect(input.dispatchEvent(event())).toBe(true);
  expect(mocks.write).not.toHaveBeenCalled();
});

function editor(ranges: ReturnType<typeof EditorSelection.range>[]) {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: "A100\nB200\nC300",
      selection: EditorSelection.create(ranges),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    }),
  });
  view.focus();
  return view;
}

it("真实 CodeMirror 多选区和输出过滤器的最终文本原样转交原生写入", () => {
  const editorView = editor([
    EditorSelection.range(0, 4),
    EditorSelection.range(10, 14),
  ]);
  editorView.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.clipboardOutputFilter.of((text) => `[${text}]`),
    ),
  });
  const data = new DataTransfer();
  editorView.contentDOM.dispatchEvent(event("copy", data));
  expect(mocks.write).toHaveBeenCalledWith("[A100\nC300]");
  expect(data.types).toHaveLength(0);
});

it("真实 CodeMirror 无选区复制保持整行粘贴语义", () => {
  const editorView = editor([EditorSelection.cursor(7)]);
  editorView.contentDOM.dispatchEvent(event());
  expect(mocks.write).toHaveBeenCalledWith("B200");
  editorView.dispatch({ selection: EditorSelection.cursor(12) });
  editorView.focus();
  const data = new DataTransfer();
  data.setData("text/plain", "B200");
  editorView.contentDOM.dispatchEvent(event("paste", data));
  expect(editorView.state.doc.toString()).toBe("A100\nB200\nB200\nC300");
});

it("附带其他格式的编辑器事件不降为纯文本", () => {
  const host = document.createElement("div");
  host.className = "cm-editor";
  document.body.append(host);
  const data = new DataTransfer();
  data.setData("text/plain", "正文");
  data.setData("text/html", "<b>正文</b>");
  const copy = event("copy", data);
  copy.preventDefault();
  host.dispatchEvent(copy);
  expect(mocks.write).not.toHaveBeenCalled();
  expect(data.types).toHaveLength(2);
});

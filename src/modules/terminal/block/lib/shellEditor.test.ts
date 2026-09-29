// @vitest-environment happy-dom
import { EditorSelection } from "@codemirror/state";
import { expect, it, vi } from "vitest";
import { createShellEditor } from "@/modules/terminal/block/lib/shellEditor";

it("Ctrl+C 有选区且允许智能复制时放行，否则中断并清空", () => {
  let smart = true;
  const interrupt = vi.fn();
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createShellEditor({
    parent,
    fontFamily: "monospace",
    fontSize: 12,
    onSubmit: vi.fn(),
    onInterrupt: interrupt,
    copySelectionOnCtrlC: () => smart,
  });
  const press = () => {
    const key = new KeyboardEvent("keydown", {
      key: "c",
      code: "KeyC",
      ctrlKey: true,
      keyCode: 67,
      bubbles: true,
      cancelable: true,
    });
    editor.view.contentDOM.dispatchEvent(key);
    return key;
  };
  try {
    editor.setValue("echo test");
    editor.view.dispatch({ selection: EditorSelection.range(0, 4) });
    editor.view.focus();
    expect(press().defaultPrevented).toBe(false);
    expect(interrupt).not.toHaveBeenCalled();
    expect(editor.getValue()).toBe("echo test");
    smart = false;
    expect(press().defaultPrevented).toBe(true);
    expect(interrupt).toHaveBeenCalledOnce();
    expect(editor.getValue()).toBe("");
    smart = true;
    editor.setValue("echo again");
    editor.view.dispatch({ selection: EditorSelection.cursor(2) });
    editor.view.focus();
    expect(press().defaultPrevented).toBe(true);
    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(editor.getValue()).toBe("");
  } finally {
    editor.destroy();
    parent.remove();
  }
});

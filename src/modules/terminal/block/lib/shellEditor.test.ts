// @vitest-environment happy-dom
import { EditorSelection } from "@codemirror/state";
import { expect, it, vi } from "vitest";
import { createShellEditor } from "@/modules/terminal/block/lib/shellEditor";

it("发送前清空输入，阻止重复提交，失败时不覆盖新输入", async () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  let finish!: (accepted: boolean) => void;
  const submit = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const editor = createShellEditor({
    parent,
    fontFamily: "monospace",
    fontSize: 12,
    onSubmit: submit,
    onInterrupt: vi.fn(),
    copySelectionOnCtrlC: () => true,
  });
  const enter = () =>
    editor.view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
  try {
    const text = "echo one\necho two";
    editor.setValue(text);
    enter();
    enter();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(text);
    expect(editor.getValue()).toBe("");
    editor.setValue("next");
    enter();
    expect(submit).toHaveBeenCalledTimes(1);
    finish(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor.getValue()).toBe("next");
    enter();
    expect(editor.getValue()).toBe("");
    finish(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor.getValue()).toBe("");
    editor.setValue("readonly");
    editor.setEditable(false);
    enter();
    expect(submit).toHaveBeenCalledTimes(2);
  } finally {
    editor.destroy();
    parent.remove();
  }
});

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

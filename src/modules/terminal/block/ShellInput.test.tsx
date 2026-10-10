// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import ShellInput from "@/modules/terminal/block/ShellInput";
import { historyRecord } from "@/modules/terminal/block/lib/history";

const mocks = vi.hoisted(() => ({
  copy: vi.fn().mockResolvedValue(undefined),
  grid: "终端输出",
  editorSelection: false,
  submit: undefined as ((text: string) => Promise<boolean>) | undefined,
}));
vi.mock("@/modules/terminal/lib/terminalClipboard", () => ({
  readTerminalClipboard: vi.fn(),
  writeTerminalClipboard: mocks.copy,
}));
vi.mock("@/lib/fonts", () => ({ resolveFontFamily: () => "monospace" }));
vi.mock("@/lib/platform", () => ({
  IS_MAC: false,
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) =>
    selector({ terminalFontSize: 12, terminalFontFamily: "monospace" }),
}));
vi.mock("@/modules/terminal/block/lib/history", () => ({
  historyCommands: async () => [],
  historyList: vi.fn(),
  historyRecord: vi.fn(),
  historySuggest: vi.fn(),
}));
vi.mock("@/modules/terminal/lib/useTerminalSession", () => ({
  clearTerminalBlockSelection: vi.fn(),
  getTerminalDraft: () => "",
  terminalGridSelection: () => mocks.grid,
  terminalUsesPowerShell: () => false,
  setTerminalDraft: vi.fn(),
  setTerminalInputActivity: vi.fn(),
  setTerminalInputFocus: vi.fn(),
  setTerminalInputPaste: vi.fn(),
}));
vi.mock("@/modules/terminal/block/lib/shellEditor", () => ({
  createShellEditor: (opts: {
    onSubmit: (text: string) => Promise<boolean>;
  }) => {
    mocks.submit = opts.onSubmit;
    return {
      view: {
        state: {
          selection: {
            get ranges() {
              return [
                { empty: true },
                ...(mocks.editorSelection ? [{ empty: false }] : []),
              ];
            },
          },
        },
      },
      focus: vi.fn(),
      destroy: vi.fn(),
      setValue: vi.fn(),
      getValue: () => "",
      retheme: vi.fn(),
      setEditable: vi.fn(),
      setPlaceholder: vi.fn(),
    };
  },
}));

it("多行原文在发送前记入历史，发送失败也可找回", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const text = "printf '%s\\n' \\\n  first \\\n  second";
  const submit = vi.fn(async () => {
    expect(historyRecord).toHaveBeenCalledWith(text);
    return false;
  });
  try {
    await act(async () =>
      root.render(
        <ShellInput
          terminalId={1}
          mode="prompt"
          focused
          themeKey="dark"
          onSubmit={submit}
          onInterrupt={() => {}}
          getCwd={() => null}
        />,
      ),
    );
    await act(async () => {
      expect(await mocks.submit?.(text)).toBe(false);
    });
    expect(submit).toHaveBeenCalledWith(text);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("输入框代复制网格选区使用原生入口，同时保留编辑器自身选区和无选区行为", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ShellInput
          terminalId={1}
          mode="prompt"
          focused
          themeKey="dark"
          onSubmit={async () => true}
          onInterrupt={() => {}}
          getCwd={() => null}
        />,
      ),
    );
    const host = container.querySelector(
      "[data-terminal-drop-surface]",
    ) as HTMLElement;
    const event = new Event("copy", { bubbles: true, cancelable: true });
    act(() => host.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.copy).toHaveBeenCalledWith("终端输出");

    mocks.copy.mockClear();
    mocks.editorSelection = true;
    const editorCopy = new Event("copy", { bubbles: true, cancelable: true });
    act(() => host.dispatchEvent(editorCopy));
    expect(editorCopy.defaultPrevented).toBe(false);
    expect(mocks.copy).not.toHaveBeenCalled();

    mocks.editorSelection = false;
    mocks.grid = "";
    const emptyCopy = new Event("copy", { bubbles: true, cancelable: true });
    act(() => host.dispatchEvent(emptyCopy));
    expect(emptyCopy.defaultPrevented).toBe(false);
    expect(mocks.copy).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

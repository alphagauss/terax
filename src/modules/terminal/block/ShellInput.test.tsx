// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import ShellInput from "@/modules/terminal/block/ShellInput";

const mocks = vi.hoisted(() => ({
  copy: vi.fn().mockResolvedValue(undefined),
  grid: "终端输出",
  editorSelection: false,
}));
vi.mock("@/modules/terminal/lib/terminalClipboard", () => ({
  readTerminalClipboard: vi.fn(),
  writeTerminalClipboard: mocks.copy,
}));
vi.mock("@/lib/fonts", () => ({ resolveFontFamily: () => "monospace" }));
vi.mock("@/lib/platform", () => ({
  fmtShortcut: () => "Ctrl+U",
  MOD_KEY: "Ctrl",
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
  setTerminalDraft: vi.fn(),
  setTerminalInputActivity: vi.fn(),
  setTerminalInputFocus: vi.fn(),
  setTerminalInputPaste: vi.fn(),
}));
vi.mock("@/modules/terminal/block/lib/shellEditor", () => ({
  createShellEditor: () => ({
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
  }),
}));

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
          onSubmit={() => {}}
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

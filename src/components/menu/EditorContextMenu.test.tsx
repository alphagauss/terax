// @vitest-environment happy-dom

import { EditorContextMenu } from "@/components/menu/EditorContextMenu";
import { history, redoDepth, undoDepth } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  windows: true,
  invoke: vi.fn(),
  error: vi.fn(),
  off: vi.fn(),
  gate: null as Promise<void> | null,
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@/lib/platform", () => ({
  get IS_WINDOWS() {
    return mocks.windows;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    listen: async (
      name: string,
      handler: (event: { payload: unknown }) => void,
    ) => {
      if (mocks.gate) await mocks.gate;
      mocks.listeners.set(name, handler);
      return () => {
        mocks.off();
        if (mocks.listeners.get(name) === handler) mocks.listeners.delete(name);
      };
    },
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));

let root: Root;
let host: HTMLDivElement;
let editor: EditorView | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.windows = true;
  mocks.gate = null;
  mocks.invoke
    .mockReset()
    .mockImplementation(async (command: string) =>
      command === "editor_menu_finish" ? true : undefined,
    );
  mocks.error.mockReset();
  mocks.off.mockReset();
  mocks.listeners.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  if (
    mocks.invoke.mock.calls.some(
      ([command]) => command === "editor_menu_connect",
    )
  ) {
    await vi.waitFor(() => expect(mocks.listeners.size).toBe(0));
  }
  editor?.destroy();
  editor = undefined;
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount() {
  await act(async () => root.render(<EditorContextMenu />));
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("editor_menu_connect", {
      connection: expect.any(String),
    }),
  );
  return mocks.invoke.mock.calls
    .filter(([command]) => command === "editor_menu_connect")
    .slice(-1)[0]?.[1].connection as string;
}
const items = [
  { id: 10, name: "copy", enabled: true, shortcut: "Ctrl+C" },
  { id: 11, name: "cut", enabled: false, shortcut: "Ctrl+X" },
  { id: 20, name: "undo", enabled: true, shortcut: "Ctrl+Z" },
  { id: 21, name: "redo", enabled: false, shortcut: "Ctrl+Shift+Z" },
];
async function open(target: HTMLElement, connection: string, id: string) {
  target.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 20,
    }),
  );
  await act(async () =>
    mocks.listeners.get("editor-menu-requested")?.({
      payload: { id, connection, items },
    }),
  );
  await vi.waitFor(() =>
    expect(document.querySelector('[role="menu"]')).not.toBeNull(),
  );
}
function item(name: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (node) => node.textContent?.startsWith(`editorMenu.${name}`),
  ) as HTMLElement;
}
function input() {
  const field = document.createElement("textarea");
  host.append(field);
  field.value = "完整选区";
  field.focus();
  field.setSelectionRange(1, 3);
  return field;
}

it("恢复原焦点与选区，只执行当前原生命令；禁用项、取消不修改内容", async () => {
  const connection = await mount();
  const field = input();
  await open(field, connection, "copy");
  await act(async () => item("cut").click());
  expect(
    mocks.invoke.mock.calls.filter(
      ([command]) => command === "editor_menu_finish",
    ),
  ).toHaveLength(0);
  await act(async () => item("copy").click());
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("editor_menu_finish", {
      connection,
      id: "copy",
      command: 10,
      restoreNative: false,
    }),
  );
  expect(document.activeElement).toBe(field);
  expect([field.selectionStart, field.selectionEnd, field.value]).toEqual([
    1,
    3,
    "完整选区",
  ]);
  await open(field, connection, "cancel");
  await act(async () =>
    document.querySelector('[role="menu"]')?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("editor_menu_finish", {
      connection,
      id: "cancel",
      command: null,
      restoreNative: false,
    }),
  );
  expect(document.activeElement).toBe(field);
});

it("真实 CodeMirror 撤销重做使用自身历史，原生只收到取消，不执行两次", async () => {
  const connection = await mount();
  editor = new EditorView({
    parent: host,
    state: EditorState.create({ doc: "原文", extensions: [history()] }),
  });
  editor.dispatch({ changes: { from: 2, insert: "修改" } });
  editor.focus();
  await open(editor.contentDOM, connection, "undo");
  expect(item("redo").getAttribute("aria-disabled")).toBe("true");
  await act(async () => item("undo").click());
  await vi.waitFor(() => expect(editor?.state.doc.toString()).toBe("原文"));
  expect(redoDepth(editor.state)).toBe(1);
  await open(editor.contentDOM, connection, "redo");
  expect(item("redo").getAttribute("aria-disabled")).not.toBe("true");
  await act(async () => item("redo").click());
  await vi.waitFor(() => expect(editor?.state.doc.toString()).toBe("原文修改"));
  expect(undoDepth(editor.state)).toBe(1);
  expect(
    mocks.invoke.mock.calls
      .filter(([command]) => command === "editor_menu_finish")
      .every(([, args]) => args.command === null),
  ).toBe(true);
});

it("只读编辑器不启用历史操作；过期请求不会执行本地撤销", async () => {
  const connection = await mount();
  editor = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: "原文",
      extensions: [history(), EditorState.readOnly.of(true)],
    }),
  });
  editor.dispatch({ changes: { from: 2, insert: "修改" } });
  editor.focus();
  await open(editor.contentDOM, connection, "readonly");
  expect(item("undo").getAttribute("aria-disabled")).toBe("true");
  expect(item("redo").getAttribute("aria-disabled")).toBe("true");
  await act(async () =>
    mocks.listeners.get("editor-menu-closed")?.({
      payload: { connection, id: "readonly" },
    }),
  );
  await vi.waitFor(() =>
    expect(document.querySelector('[role="menu"]')).toBeNull(),
  );
  expect(editor.state.doc.toString()).toBe("原文修改");
});

it("其他连接的事件不显示菜单，密码字段恢复宿主菜单", async () => {
  const connection = await mount();
  const field = input();
  field.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  await act(async () =>
    mocks.listeners.get("editor-menu-requested")?.({
      payload: { connection: "another-window", id: "foreign", items },
    }),
  );
  expect(document.querySelector('[role="menu"]')).toBeNull();
  const password = document.createElement("input");
  password.type = "password";
  host.append(password);
  password.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  await act(async () =>
    mocks.listeners.get("editor-menu-requested")?.({
      payload: { connection, id: "password", items },
    }),
  );
  expect(mocks.invoke).toHaveBeenCalledWith("editor_menu_finish", {
    connection,
    id: "password",
    command: null,
    restoreNative: true,
  });
});

it("原生请求过期时不执行 CodeMirror 历史，目标移除时只取消复制", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const connection = await mount();
  editor = new EditorView({
    parent: host,
    state: EditorState.create({ doc: "原文", extensions: [history()] }),
  });
  editor.dispatch({ changes: { from: 2, insert: "修改" } });
  editor.focus();
  await open(editor.contentDOM, connection, "expired");
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "editor_menu_finish" ? false : undefined,
  );
  await act(async () => item("undo").click());
  await vi.waitFor(() =>
    expect(mocks.error).toHaveBeenCalledWith("editorMenu.failed"),
  );
  expect(editor.state.doc.toString()).toBe("原文修改");
  const field = input();
  await open(field, connection, "detached");
  field.remove();
  await act(async () => item("copy").click());
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("editor_menu_finish", {
      connection,
      id: "detached",
      command: null,
      restoreNative: false,
    }),
  );
});

it("非 Windows 不建立原生连接", async () => {
  mocks.windows = false;
  await act(async () => root.render(<EditorContextMenu />));
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(mocks.listeners.size).toBe(0);
});

it("连续打开不同输入框菜单时，旧菜单清理不能夺走新菜单焦点", async () => {
  const connection = await mount();
  const first = input();
  await open(first, connection, "first");
  const second = input();
  await open(second, connection, "second");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const menu = document.querySelector('[role="menu"]');
  expect(menu).not.toBeNull();
  expect(menu?.contains(document.activeElement)).toBe(true);
  await act(async () => item("copy").click());
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("editor_menu_finish", {
      connection,
      id: "second",
      command: 10,
      restoreNative: false,
    }),
  );
  expect(document.activeElement).toBe(second);
});

it("初始化未完成即卸载时，不遗留监听或覆盖后续连接", async () => {
  let release = () => {};
  mocks.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await act(async () => root.render(<EditorContextMenu />));
  await act(async () => root.render(null));
  await act(async () => root.render(<EditorContextMenu />));
  await act(async () => {
    release();
  });
  await vi.waitFor(() =>
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "editor_menu_connect",
      ),
    ).toHaveLength(1),
  );
  expect(mocks.listeners.size).toBe(2);
  expect(mocks.off).toHaveBeenCalledTimes(2);
});

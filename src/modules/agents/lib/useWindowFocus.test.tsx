// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWindowFocus } from "./useWindowFocus";

const mocks = vi.hoisted(() => ({
  isFocused: vi.fn(),
  unlisten: vi.fn(),
  onFocus: null as null | ((event: { payload: boolean }) => void),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFocused: mocks.isFocused,
    onFocusChanged: async (handler: typeof mocks.onFocus) => {
      mocks.onFocus = handler;
      return mocks.unlisten;
    },
  }),
}));

let root: Root;
let focused: boolean;
function Probe() {
  focused = useWindowFocus();
  return null;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
});

it("WebView 未聚焦时仍以原生窗口前台状态初始化，并跟踪后续切换", async () => {
  mocks.isFocused.mockResolvedValue(true);
  await act(async () => root.render(<Probe />));
  expect(focused).toBe(true);
  act(() => mocks.onFocus?.({ payload: false }));
  expect(focused).toBe(false);
  act(() => mocks.onFocus?.({ payload: true }));
  expect(focused).toBe(true);
});

it("初始化查询不能覆盖查询期间更新的焦点事件", async () => {
  let resolve!: (value: boolean) => void;
  mocks.isFocused.mockReturnValue(
    new Promise<boolean>((done) => {
      resolve = done;
    }),
  );
  await act(async () => root.render(<Probe />));
  act(() => mocks.onFocus?.({ payload: true }));
  await act(async () => resolve(false));
  expect(focused).toBe(true);
});

it("卸载时解除订阅，未完成查询不再更新状态", async () => {
  let resolve!: (value: boolean) => void;
  mocks.isFocused.mockReturnValue(
    new Promise<boolean>((done) => {
      resolve = done;
    }),
  );
  await act(async () => root.render(<Probe />));
  act(() => root.unmount());
  await act(async () => resolve(true));
  expect(mocks.unlisten).toHaveBeenCalledOnce();
  expect(focused).toBe(false);
});

/**
 * 本文件测试辅助窗口打开请求的快照与事件合并。
 * 测试锁定先监听后读取以及旧 revision 不得覆盖最新目标的不变量。
 */

// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequest: vi.fn(),
  listener: null as ((event: { payload: unknown }) => void) | null,
  unlisten: vi.fn(),
}));

vi.mock("@/auxiliary/openAuxiliaryWindow", () => ({
  AUXILIARY_OPEN_EVENT: "terax:auxiliary-open",
  getAuxiliaryWindowRequest: mocks.getRequest,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    listen: vi.fn(
      async (
        _event: string,
        listener: (event: { payload: unknown }) => void,
      ) => {
        mocks.listener = listener;
        return mocks.unlisten;
      },
    ),
  }),
}));

import { useAuxiliaryOpenRequest } from "@/auxiliary/useAuxiliaryOpenRequest";

function Probe() {
  const envelope = useAuxiliaryOpenRequest();
  return createElement("span", null, envelope?.revision ?? "none");
}

describe("辅助窗口打开请求", () => {
  afterEach(() => {
    mocks.getRequest.mockReset();
    mocks.listener = null;
    mocks.unlisten.mockReset();
  });

  it("以最新 revision 合并快照和复用事件", async () => {
    mocks.getRequest.mockResolvedValue({
      revision: 2,
      request: { kind: "settings", tab: "general" },
    });
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(Probe));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toBe("2");

    act(() => {
      mocks.listener?.({
        payload: {
          revision: 1,
          request: { kind: "settings", tab: "themes" },
        },
      });
    });
    expect(container.textContent).toBe("2");

    act(() => {
      mocks.listener?.({
        payload: {
          revision: 3,
          request: { kind: "settings", tab: "themes" },
        },
      });
    });
    expect(container.textContent).toBe("3");

    act(() => root.unmount());
    await Promise.resolve();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });
});

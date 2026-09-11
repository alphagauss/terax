// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useTerminalFileDrop } from "@/modules/terminal/lib/useTerminalFileDrop";
import { useTerminalDropStore } from "@/modules/terminal/lib/dropStore";

const mocks = vi.hoisted(() => ({
  kind: "local",
  paste: vi.fn(),
  info: vi.fn(),
  unlisten: vi.fn(),
  handler: null as
    | ((event: {
        payload: {
          type: "enter" | "drop";
          paths: string[];
          position: { x: number; y: number };
        };
      }) => void)
    | null,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: typeof mocks.handler) => {
      mocks.handler = handler;
      return mocks.unlisten;
    },
  }),
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: mocks.kind }),
}));
vi.mock("@/modules/terminal/lib/rendererPool", () => ({
  pasteIntoTerminal: mocks.paste,
}));
vi.mock("@/lib/platform", () => ({ IS_WINDOWS: false }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { info: mocks.info } }));

it.each(["local", "wsl", "ssh"])(
  "远端不接受文件也不显示边框，本机只标记实际终端接收表面：%s",
  async (kind) => {
    const env = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean;
    };
    env.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.kind = kind;
    const point = vi.spyOn(document, "elementFromPoint");
    const target = document.createElement("section");
    const content = document.createElement("div");
    content.className = "zoom-exempt";
    target.append(content);
    target.dataset.terminalId = "7";
    target.dataset.terminalDropSurface = "input";
    point.mockReturnValue(content);
    const root = createRoot(document.createElement("div"));
    function Harness() {
      useTerminalFileDrop();
      return null;
    }
    try {
      await act(async () => root.render(<Harness />));
      act(() =>
        mocks.handler?.({
          payload: {
            type: "enter",
            paths: ["/host/a b.png"],
            position: { x: 10, y: 10 },
          },
        }),
      );
      expect(useTerminalDropStore.getState().targetTerminalId).toBe(
        kind === "local" ? 7 : null,
      );
      if (kind === "local")
        expect(useTerminalDropStore.getState().targetSurface).toBe("input");
      act(() =>
        mocks.handler?.({
          payload: {
            type: "drop",
            paths: ["/host/a b.png"],
            position: { x: 10, y: 10 },
          },
        }),
      );
      if (kind === "local")
        expect(mocks.paste).toHaveBeenCalledWith(7, "'/host/a b.png' ");
      else {
        expect(mocks.paste).not.toHaveBeenCalled();
        expect(mocks.info).toHaveBeenCalledWith(
          "common:fileActions.remoteFileInputRejected",
        );
      }
      expect(useTerminalDropStore.getState().targetTerminalId).toBeNull();
    } finally {
      act(() => root.unmount());
      expect(mocks.unlisten).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
      env.IS_REACT_ACT_ENVIRONMENT = false;
    }
  },
);

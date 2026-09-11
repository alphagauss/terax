// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useComposerDrop } from "@/modules/ai/hooks/useComposerDrop";
import type { useComposer } from "@/modules/ai/lib/composer";
import {
  resourceDropTargetAt,
  finishResourceDrop,
} from "@/modules/file-actions/resourceDrop";

type Payload = {
  type: "enter" | "drop";
  position: { x: number; y: number };
  paths: string[];
};
const mocks = vi.hoisted(() => ({
  handler: null as ((event: { payload: Payload }) => void) | null,
  unlisten: vi.fn(),
  info: vi.fn(),
  t: (key: string) => key,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: typeof mocks.handler) => {
      mocks.handler = handler;
      return mocks.unlisten;
    },
  }),
}));
vi.mock("@/modules/ai/store/chatStore", () => ({
  useChatStore: { getState: () => ({ activeSessionId: "session" }) },
}));
vi.mock("sonner", () => ({ toast: { info: mocks.info } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }));

it.each([true, false])(
  "宿主文件按环境限制，工作区拖放复用附加且卸载后不接收：local=%s",
  async (local) => {
    const env = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean;
    };
    env.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    const attachFileByPath = vi.fn().mockResolvedValue(undefined);
    const composer = {
      canPickFiles: local,
      readOnly: false,
      attachFileByPath,
    } as unknown as ReturnType<typeof useComposer>;
    function Harness() {
      const drop = useComposerDrop(composer);
      return (
        <div ref={drop.ref} data-active={drop.active}>
          <span />
        </div>
      );
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    const point = vi.spyOn(document, "elementFromPoint");
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
    try {
      await act(async () => root.render(<Harness />));
      point.mockReturnValue(container.querySelector("span"));
      act(() =>
        mocks.handler?.({
          payload: {
            type: "enter",
            position: { x: 300, y: 200 },
            paths: ["C:/a.txt"],
          },
        }),
      );
      expect(point).toHaveBeenLastCalledWith(150, 100);
      expect(container.firstElementChild?.getAttribute("data-active")).toBe(
        String(local),
      );
      act(() =>
        mocks.handler?.({
          payload: {
            type: "drop",
            position: { x: 300, y: 200 },
            paths: ["C:/a.txt", "C:/a.txt"],
          },
        }),
      );
      expect(attachFileByPath).toHaveBeenCalledTimes(local ? 1 : 0);
      if (!local)
        expect(mocks.info).toHaveBeenCalledWith(
          "common:fileActions.remoteFileInputRejected",
        );
      const target = resourceDropTargetAt(150, 100);
      if (!target) throw new Error("缺少工作区拖放目标");
      act(() => finishResourceDrop(target, "/workspace/a.txt", true));
      if (local)
        expect(attachFileByPath).toHaveBeenLastCalledWith("/workspace/a.txt");
      composer.readOnly = true;
      act(() => finishResourceDrop(target, "/workspace/blocked.txt", true));
      expect(attachFileByPath).toHaveBeenCalledTimes(local ? 2 : 0);
      act(() => root.unmount());
      expect(mocks.unlisten).toHaveBeenCalledTimes(1);
      finishResourceDrop(target, "/workspace/gone.txt", true);
      expect(attachFileByPath).toHaveBeenCalledTimes(local ? 2 : 0);
      expect(resourceDropTargetAt(150, 100)).toBeNull();
    } finally {
      act(() => root.unmount());
      vi.restoreAllMocks();
      env.IS_REACT_ACT_ENVIRONMENT = false;
    }
  },
);

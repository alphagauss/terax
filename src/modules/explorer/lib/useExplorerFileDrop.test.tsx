// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useExplorerFileDrop } from "@/modules/explorer/lib/useExplorerFileDrop";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  invoke: vi.fn(),
  enqueue: vi.fn(),
  panel: vi.fn(),
  kind: "local",
  t: (key: string) => key,
  handler: null as
    | ((event: {
        payload: {
          type: "drop";
          paths: string[];
          position: { x: number; y: number };
        };
      }) => void)
    | null,
}));
vi.mock("@/modules/file-actions/clipboard", () => ({
  readClipboardFiles: mocks.read,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: typeof mocks.handler) => {
      mocks.handler = handler;
      return () => {};
    },
  }),
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: mocks.kind }),
}));
vi.mock("@/modules/transfers/native", () => ({
  transferNative: { enqueue: mocks.enqueue },
}));
vi.mock("@/modules/transfers/store", () => ({
  requestTransferPanel: mocks.panel,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock("sonner", () => ({
  toast: { info: vi.fn(), success: vi.fn() },
}));
vi.mock("@/lib/errors", () => ({ reportError: vi.fn() }));

it.each(["local", "wsl", "ssh"])(
  "粘贴冻结目标，拖放共用复制或上传，纯内存数据不导入：%s",
  async (kind) => {
    const env = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean;
    };
    env.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.kind = kind;
    mocks.invoke.mockResolvedValue(undefined);
    mocks.enqueue.mockResolvedValue({ id: "transfer" });
    let resolve!: (files: string[]) => void;
    mocks.read.mockReturnValue(
      new Promise<string[]>((r) => {
        resolve = r;
      }),
    );
    let controller: ReturnType<typeof useExplorerFileDrop>;
    const refreshed = vi.fn();
    function Harness({ rootPath }: { rootPath: string }) {
      controller = useExplorerFileDrop({
        rootPath,
        isDir: (path) => path !== "/file.txt",
        onCopied: refreshed,
      });
      return <div data-explorer-drop />;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    const point = vi.spyOn(document, "elementFromPoint");
    try {
      await act(async () => root.render(<Harness rootPath="/first" />));
      let pending: Promise<void>;
      act(() => {
        pending = controller.pasteFiles("/first/selected");
      });
      await act(async () => root.render(<Harness rootPath="/second" />));
      await act(async () => {
        resolve(["/host/image.png", "/host/code.ts"]);
        await pending;
      });
      if (kind === "local") {
        expect(mocks.invoke).toHaveBeenCalledWith("fs_copy", {
          sources: ["/host/image.png", "/host/code.ts"],
          destDir: "/first/selected",
          workspace: { kind },
        });
        expect(refreshed).toHaveBeenCalledWith("/first/selected");
        expect(mocks.enqueue).not.toHaveBeenCalled();
      } else {
        expect(mocks.enqueue).toHaveBeenCalledWith({
          direction: "upload",
          strategy: "direct",
          sources: ["/host/image.png", "/host/code.ts"],
          destination: "/first/selected",
        });
        expect(mocks.invoke).not.toHaveBeenCalled();
        expect(mocks.panel).toHaveBeenCalledWith("transfer");
      }
      point.mockReturnValue(container.firstElementChild);
      await act(async () =>
        mocks.handler?.({
          payload: {
            type: "drop",
            paths: ["/host/other.txt"],
            position: { x: 10, y: 10 },
          },
        }),
      );
      const calls = kind === "local" ? mocks.invoke : mocks.enqueue;
      expect(calls).toHaveBeenCalledTimes(2);
      const rootFile = document.createElement("div");
      rootFile.dataset.fsPath = "/file.txt";
      point.mockReturnValue(rootFile);
      await act(async () =>
        mocks.handler?.({
          payload: {
            type: "drop",
            paths: ["/host/root.txt"],
            position: { x: 10, y: 10 },
          },
        }),
      );
      if (kind === "local") {
        expect(mocks.invoke).toHaveBeenLastCalledWith("fs_copy", {
          sources: ["/host/root.txt"],
          destDir: "/",
          workspace: { kind },
        });
      } else {
        expect(mocks.enqueue).toHaveBeenLastCalledWith({
          direction: "upload",
          strategy: "direct",
          sources: ["/host/root.txt"],
          destination: "/",
        });
      }
      mocks.read.mockResolvedValue([]);
      await act(async () => controller.pasteFiles("/second"));
      expect(calls).toHaveBeenCalledTimes(3);
    } finally {
      act(() => root.unmount());
      vi.restoreAllMocks();
      env.IS_REACT_ACT_ENVIRONMENT = false;
    }
  },
);

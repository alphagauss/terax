// @vitest-environment happy-dom
import { act, type ClipboardEvent, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useComposerClipboard } from "@/modules/ai/hooks/useComposerClipboard";
import type { useComposer } from "@/modules/ai/lib/composer";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  session: "a",
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("sonner", () => ({ toast: { info: mocks.info } }));
vi.mock("@/lib/errors", () => ({ reportError: mocks.error }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/modules/ai/store/chatStore", () => ({
  useChatStore: { getState: () => ({ activeSessionId: mocks.session }) },
}));
const env = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
beforeEach(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.session = "a";
});
afterEach(() => {
  env.IS_REACT_ACT_ENVIRONMENT = false;
});

function setup(local = true) {
  let handler: ReturnType<typeof useComposerClipboard>;
  const attachFileByPath = vi.fn().mockResolvedValue(undefined);
  const addFiles = vi.fn().mockResolvedValue(undefined);
  const setValue = vi.fn();
  function Harness() {
    handler = useComposerClipboard({
      canPickFiles: local,
      readOnly: false,
      attachFileByPath,
      addFiles,
      setValue,
    } as unknown as ReturnType<typeof useComposer>);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
  const input = document.createElement("textarea");
  const paste = (files: File[] = [], text = "") => {
    const event = {
      clipboardData: {
        files,
        items: [],
        types: files.length ? ["Files"] : ["text/plain"],
        getData: () => text,
      },
      currentTarget: input,
      preventDefault: vi.fn(),
    };
    handler.onPaste(event as unknown as ClipboardEvent<HTMLTextAreaElement>);
    return event;
  };
  return {
    attachFileByPath,
    addFiles,
    setValue,
    paste,
    key: () =>
      handler.onKeyDown({
        key: "v",
        ctrlKey: true,
      } as KeyboardEvent<HTMLTextAreaElement>),
    close: () => act(() => root.unmount()),
  };
}

it.each([true, false])(
  "路径优先于图片数据，同一次键盘和 paste 只读取一次；local=%s",
  async (local) => {
    let resolve!: (paths: string[]) => void;
    mocks.invoke.mockReturnValue(
      new Promise<string[]>((r) => {
        resolve = r;
      }),
    );
    const h = setup(local);
    try {
      h.key();
      h.paste([new File(["image"], "a.png", { type: "image/png" })]);
      await act(async () => resolve(["C:/a.png"]));
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
      expect(h.addFiles).not.toHaveBeenCalled();
      expect(h.attachFileByPath).toHaveBeenCalledTimes(local ? 1 : 0);
      if (!local)
        expect(mocks.info).toHaveBeenCalledWith(
          "common:fileActions.remoteFileInputRejected",
        );
    } finally {
      h.close();
    }
  },
);

it("没有 DOM paste 时仍附加文件，切换会话后忽略晚到读取", async () => {
  const h = setup();
  try {
    mocks.invoke.mockResolvedValueOnce(["C:/a.txt"]);
    await act(async () => h.key());
    expect(h.attachFileByPath).toHaveBeenCalledWith("C:/a.txt");
    let resolve!: (paths: string[]) => void;
    mocks.invoke.mockReturnValue(
      new Promise<string[]>((r) => {
        resolve = r;
      }),
    );
    h.key();
    mocks.session = "b";
    await act(async () => resolve(["C:/b.txt"]));
    expect(h.attachFileByPath).toHaveBeenCalledTimes(1);
  } finally {
    h.close();
  }
});

it("远端允许内存图片，普通文本保留默认粘贴；读取失败不能降级附加图片", async () => {
  const h = setup(false);
  const image = new File(["image"], "a.png", { type: "image/png" });
  try {
    mocks.invoke.mockResolvedValueOnce([]);
    await act(async () => {
      h.paste([image]);
    });
    expect(h.addFiles).toHaveBeenCalledWith([image]);
    const event = h.paste([], "C:/looks-like-a-path.txt");
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    mocks.invoke.mockRejectedValueOnce(new Error("clipboard occupied"));
    await act(async () => {
      h.paste([image]);
    });
    expect(h.addFiles).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith("composer.clipboardFailed");
  } finally {
    h.close();
  }
});

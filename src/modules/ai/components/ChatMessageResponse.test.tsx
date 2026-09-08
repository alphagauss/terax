// @vitest-environment happy-dom
import { ChatMessageResponse } from "@/modules/ai/components/ChatMessageResponse";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  url: vi.fn(),
  copy: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: mocks.url,
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}));
vi.mock("@/modules/ai/store/chatStore", () => ({
  useChatStore: {
    getState: () => ({ live: { openFileReference: mocks.open } }),
  },
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.copy },
  });
});

describe("chat file references", () => {
  it("does not copy a previous link target while the new context menu is loading", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const show = (path: string) =>
      act(async () =>
        root.render(
          <ChatMessageResponse>{`[file](${path})`}</ChatMessageResponse>,
        ),
      );
    const menu = () =>
      act(async () => {
        container
          .querySelector("a")
          ?.dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, button: 2 }),
          );
      });
    await show("D:/old.ts");
    mocks.invoke.mockResolvedValueOnce({ kind: "file" });
    await menu();
    await show("D:/new.ts");
    let finishLookup: ((value: { kind: string }) => void) | undefined;
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLookup = resolve;
        }),
    );
    await menu();
    mocks.invoke.mockRejectedValueOnce(new Error("missing"));
    await act(async () => {
      const copy = [
        ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ].find((element) => element.textContent === "fileActions.copyPath");
      expect(copy).toBeDefined();
      copy?.click();
    });
    expect(mocks.copy).toHaveBeenCalledWith("D:/new.ts");
    await act(async () => {
      finishLookup?.({ kind: "file" });
    });
    await act(async () => root.unmount());
    container.remove();
  });
  it.each([false, true])(
    "preserves Windows, POSIX and spaced paths through the real security pipeline (streaming=%s)",
    async (streaming) => {
      const container = document.createElement("div");
      const root = createRoot(container);
      await act(async () =>
        root.render(
          <ChatMessageResponse streaming={streaming}>
            {
              "[win](D:/project/config.ts:12) [unix](/workspace/config.ts:5) [space](</workspace/my project/配置.ts:9>) [percent](D:/work/a%2520b.ts:4)"
            }
          </ChatMessageResponse>,
        ),
      );
      expect([...container.querySelectorAll("a")].map((a) => a.title)).toEqual([
        "D:/project/config.ts:12",
        "/workspace/config.ts:5",
        "/workspace/my project/配置.ts:9",
        "D:/work/a%20b.ts:4",
      ]);
      expect(mocks.invoke).not.toHaveBeenCalled();
      mocks.invoke.mockResolvedValue({ kind: "file" });
      await act(async () => container.querySelector("a")?.click());
      expect(mocks.open).toHaveBeenCalledWith("D:/project/config.ts", 12);
      await act(async () => root.unmount());
    },
  );

  it("does not activate incomplete links, code literals or unsafe protocols", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <ChatMessageResponse streaming>
          {
            "`[code](D:/file.ts:2)`\n\n[bad](javascript:alert%281%29)\n\n[forged](terax-file:%2Ftmp%2Ffile)\n\n[unfinished](D:/file.ts:12"
          }
        </ChatMessageResponse>,
      ),
    );
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});

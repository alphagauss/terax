// @vitest-environment happy-dom
import { ChatMessageResponse } from "@/modules/ai/components/ChatMessageResponse";
import { act } from "react";
import { decodeFileReference } from "@/modules/file-actions/references";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  url: vi.fn(),
  copy: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
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
  it("uses the table-style copy control for fenced code", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ChatMessageResponse>
          {"```ts\nconst answer = 42;\n```"}
        </ChatMessageResponse>,
      );
    });

    const copy = container.querySelector<HTMLButtonElement>(
      '[aria-label="Copy code"]',
    );
    expect(copy?.className).toContain("p-1");
    await act(async () => copy?.click());
    expect(mocks.copy).toHaveBeenCalledWith("const answer = 42;");

    await act(async () => root.unmount());
  });

  it("keeps table copy and download menus mutually exclusive", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ChatMessageResponse>{`| Name |
| --- |
| Terax |`}</ChatMessageResponse>,
      );
    });
    const copy = container.querySelector<HTMLButtonElement>(
      '[aria-label="table.copy"]',
    );
    const download = container.querySelector<HTMLButtonElement>(
      '[aria-label="table.download"]',
    );

    const open = async (button: HTMLButtonElement | null) => {
      await act(async () => {
        button?.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            pointerType: "mouse",
          }),
        );
        button?.click();
      });
    };

    await open(copy);
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
    await open(download);
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
    expect(copy?.getAttribute("aria-expanded")).toBe("false");
    expect(download?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="table.viewFullscreen"]')
        ?.click(),
    );
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    await open(dialog?.querySelector('[aria-label="table.copy"]') ?? null);
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
    expect(copy?.getAttribute("aria-expanded")).toBe("false");
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  it("uses the project copy control and copies Markdown table content", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ChatMessageResponse>{`| Name | Value |
| --- | --- |
| Terax | 1 |`}</ChatMessageResponse>,
      );
    });

    const copy = container.querySelector<HTMLButtonElement>(
      '[aria-label="table.copy"]',
    );
    expect(copy).not.toBeNull();
    expect(copy?.getAttribute("title")).toBeNull();
    await act(async () => {
      copy?.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerType: "mouse",
        }),
      );
      copy?.click();
    });

    const markdown = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((element) => element.textContent === "table.format.markdown");
    expect(markdown).toBeDefined();
    await act(async () => markdown?.click());

    expect(mocks.copy).toHaveBeenCalledWith(
      "| Name | Value |\n| --- | --- |\n| Terax | 1 |",
    );
    expect(copy?.getAttribute("aria-label")).toBe("table.copied");
    const write = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator.clipboard, { write });
    await act(async () => {
      copy?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      copy?.click();
    });
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent === "table.format.markdown")
        ?.click(),
    );
    const item = write.mock.calls[0][0][0] as ClipboardItem;
    expect(await (await item.getType("text/plain")).text()).toBe(
      "| Name | Value |\n| --- | --- |\n| Terax | 1 |",
    );
    expect(await (await item.getType("text/html")).text()).toContain("<table");
    await act(async () => root.unmount());
    container.remove();
  });

  it.each([
    ["markdown", "md", "| 名称 |\n| --- |\n| Terax |"],
    ["csv", "csv", "\uFEFF名称\nTerax"],
    ["tsv", "tsv", "名称\nTerax"],
  ])(
    "exports %s and distinguishes cancellation, failure, and success",
    async (format, extension, content) => {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      await act(async () =>
        root.render(
          <ChatMessageResponse>
            {"| 名称 |\n| --- |\n| Terax |"}
          </ChatMessageResponse>,
        ),
      );
      const download = container.querySelector<HTMLButtonElement>(
        '[aria-label="table.download"]',
      );
      expect(download).not.toBeNull();
      const save = async () => {
        await act(async () => {
          download?.dispatchEvent(
            new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
          );
          download?.click();
        });
        await act(async () =>
          [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
            .find((item) => item.textContent === `table.format.${format}`)
            ?.click(),
        );
      };
      mocks.invoke.mockResolvedValueOnce(false);
      await save();
      expect(mocks.invoke).toHaveBeenLastCalledWith("text_save_as", {
        content,
        extension,
        filename: `table.${extension}`,
        title: "table.save",
        fileFilter: `table.format.${format}`,
      });
      expect(mocks.success).not.toHaveBeenCalled();
      expect(mocks.error).not.toHaveBeenCalled();
      mocks.invoke.mockRejectedValueOnce(new Error("disk full"));
      await save();
      expect(mocks.error).toHaveBeenCalledWith("table.downloadFailed");
      expect(download?.disabled).toBe(false);
      mocks.invoke.mockResolvedValueOnce(true);
      await save();
      expect(mocks.success).toHaveBeenCalledWith("table.downloaded");
      await act(async () => root.unmount());
      container.remove();
    },
  );

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
      expect(
        [...container.querySelectorAll("a")].map(
          (a) => decodeFileReference(a.getAttribute("href") ?? "")?.literalPath,
        ),
      ).toEqual([
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

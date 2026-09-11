// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import { preloadEn } from "@/i18n";
import { MessageAttachments } from "@/modules/ai/components/MessageAttachments";
import AttachmentPreview from "@/modules/ai/components/AttachmentPreview";
import { appendTextAttachment } from "@/modules/ai/lib/messageAttachments";

const mocks = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(true) }));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<object>()),
  invoke: mocks.invoke,
}));
vi.mock("@/modules/workspace-process", () => ({
  currentWorkspaceBootstrap: () => ({ environmentKey: "local" }),
}));

it("附件初始只展示入口，预览与另存为读取发送快照，图片复用原 URL 并支持缩放", async () => {
  await preloadEn();
  const env = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  };
  env.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const content = "发送内容\n</file>\n保留末尾换行\n";
  const file = appendTextAttachment("", {
    name: "note.txt",
    size: 42,
    text: content,
    mediaType: "text/plain",
    sourcePath: "C:/deleted/note.txt",
    environmentKey: "local",
  });
  const url = "data:image/png;base64,aGVsbG8=";
  const message: UIMessage = {
    id: "user",
    role: "user",
    parts: [
      { type: "text", text: file.text },
      { type: "file", mediaType: "image/png", filename: "shot.png", url },
    ],
    metadata: { attachments: [file.attachment] },
  };
  try {
    act(() => root.render(<MessageAttachments message={message} />));
    expect(container.textContent).toContain("note.txt");
    expect(container.textContent).not.toContain(content);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(url);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Preview note.txt"]',
        )
        ?.click();
      await import("@/modules/ai/components/AttachmentPreview");
    });
    expect(document.querySelector("pre")?.textContent).toBe(content);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await act(async () => {
      const save = [...document.querySelectorAll("button")].find(
        (b) => b.textContent === "Save sent content as…",
      );
      save?.click();
    });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "text_save_as",
      expect.objectContaining({ content, filename: "note.txt" }),
    );
    act(() =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Preview shot.png"]',
        )
        ?.click(),
    );
    const image = document.querySelector<HTMLImageElement>(
      '[role="dialog"] img',
    );
    expect(image?.getAttribute("src")).toBe(url);
    act(() =>
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === "Zoom in")
        ?.click(),
    );
    expect(image?.style.width).toBe("125%");
    act(() =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    env.IS_REACT_ACT_ENVIRONMENT = false;
  }
});

it.each(["Dockerfile", ".env", "test.constructor"])(
  "预览 %s 不错误推断语言或另存为扩展名",
  async (name) => {
    await preloadEn();
    const env = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean;
    };
    env.IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement("div"));
    const file = appendTextAttachment("", {
      name,
      size: 4,
      mediaType: "text/plain",
      text: "text",
    });
    const message: UIMessage = {
      id: "user",
      role: "user",
      parts: [{ type: "text", text: file.text }],
    };
    try {
      await act(async () =>
        root.render(
          <AttachmentPreview
            item={{ display: file.attachment }}
            message={message}
            onClose={() => {}}
          />,
        ),
      );
      expect(document.querySelector("pre")?.textContent).toBe("text");
      await act(async () =>
        [...document.querySelectorAll("button")]
          .find((button) => button.textContent === "Save sent content as…")
          ?.click(),
      );
      expect(mocks.invoke).toHaveBeenLastCalledWith(
        "text_save_as",
        expect.objectContaining({
          filename: name,
          extension: name === "test.constructor" ? "constructor" : null,
        }),
      );
    } finally {
      act(() => root.unmount());
      env.IS_REACT_ACT_ENVIRONMENT = false;
    }
  },
);

it.each(["local", "ssh:other"])(
  "源文件菜单只在环境一致时可用：%s",
  async (environmentKey) => {
    await preloadEn();
    const env = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean;
    };
    env.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const file = appendTextAttachment("", {
      name: "note.txt",
      size: 4,
      mediaType: "text/plain",
      text: "text",
      sourcePath: "/work/note.txt",
      environmentKey,
    });
    const message: UIMessage = {
      id: "user",
      role: "user",
      parts: [{ type: "text", text: file.text }],
      metadata: { attachments: [file.attachment] },
    };
    try {
      act(() => root.render(<MessageAttachments message={message} />));
      act(() =>
        container
          .querySelector("button")
          ?.dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, button: 2 }),
          ),
      );
      expect(document.querySelector('[role="menu"]')?.textContent).toContain(
        "View sent content",
      );
      expect(
        document
          .querySelector('[role="menu"]')
          ?.textContent?.includes("Source file"),
      ).toBe(environmentKey === "local");
    } finally {
      act(() => root.unmount());
      container.remove();
      env.IS_REACT_ACT_ENVIRONMENT = false;
    }
  },
);

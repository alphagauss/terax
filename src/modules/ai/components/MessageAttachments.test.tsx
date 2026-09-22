// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import { preloadEn } from "@/i18n";
import { MessageAttachments } from "@/modules/ai/components/MessageAttachments";

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/modules/ai/store/chatStore", () => ({
  useChatStore: {
    getState: () => ({ live: { openFileReference: mocks.open } }),
  },
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));
vi.mock("@/modules/workspace-process", () => ({
  currentWorkspaceBootstrap: () => ({ environmentKey: "local" }),
}));

beforeEach(() => vi.clearAllMocks());

it("路径附件左键复用工作区打开，右键复用完整公共文件菜单", async () => {
  await preloadEn();
  const env = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  };
  env.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const message: UIMessage = {
    id: "user",
    role: "user",
    parts: [],
    metadata: {
      attachments: [
        {
          kind: "file",
          name: "note.bin",
          size: 42,
          path: "C:/work/note.bin",
          environmentKey: "local",
        },
      ],
    },
  };
  try {
    act(() => root.render(<MessageAttachments message={message} />));
    const button = container.querySelector("button");
    act(() => button?.click());
    expect(mocks.open).toHaveBeenCalledWith("C:/work/note.bin", undefined);

    act(() =>
      button?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, button: 2 }),
      ),
    );
    const menu = document.querySelector('[role="menu"]')?.textContent ?? "";
    for (const label of [
      "Open file",
      "Open with…",
      "Save as…",
      "Copy path",
      "Copy file contents",
      "Show in file manager",
    ])
      expect(menu).toContain(label);
    expect(menu).not.toContain("View sent content");
  } finally {
    act(() => root.unmount());
    container.remove();
    env.IS_REACT_ACT_ENVIRONMENT = false;
  }
});

it("图片仍复用消息媒体并打开预览", async () => {
  await preloadEn();
  const env = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  };
  env.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const url = "data:image/png;base64,aGVsbG8=";
  const message: UIMessage = {
    id: "user",
    role: "user",
    parts: [
      { type: "file", mediaType: "image/png", filename: "shot.png", url },
    ],
    metadata: {
      attachments: [
        { kind: "image", name: "shot.png", size: 5, mediaIndex: 0 },
      ],
    },
  };
  try {
    await act(async () => {
      root.render(<MessageAttachments message={message} />);
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Preview shot.png"]',
        )
        ?.click();
      await import("@/modules/ai/components/AttachmentPreview");
    });
    expect(
      document.querySelector<HTMLImageElement>('[role="dialog"] img')?.src,
    ).toBe(url);
  } finally {
    act(() => root.unmount());
    container.remove();
    env.IS_REACT_ACT_ENVIRONMENT = false;
  }
});

it("其他环境的路径附件不可由当前 Workspace 打开", async () => {
  await preloadEn();
  const container = document.createElement("div");
  const root = createRoot(container);
  const message: UIMessage = {
    id: "user",
    role: "user",
    parts: [],
    metadata: {
      attachments: [
        {
          kind: "file",
          name: "remote.txt",
          size: 4,
          path: "/work/remote.txt",
          environmentKey: "ssh:other",
        },
      ],
    },
  };
  try {
    act(() => root.render(<MessageAttachments message={message} />));
    expect(container.querySelector("button")?.disabled).toBe(true);
    act(() => container.querySelector("button")?.click());
    expect(mocks.open).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});

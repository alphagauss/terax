// @vitest-environment happy-dom
/** 验证 Markdown 标签页的文件引用经过真实安全管线并把行号交给工作台导航。 */
import { prepareMarkdownDocument } from "@/modules/markdown/lib/document";
import { MarkdownDocumentRenderer } from "@/modules/markdown/MarkdownDocumentRenderer";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openPath: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  openPath: mocks.openPath,
  revealItemInDir: vi.fn(),
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, options?: { line?: number }) =>
      key === "fileActions.lineReference"
        ? `(line:${options?.line})`
        : key,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceEnvStore.getState().setEnv({ kind: "local" });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(() => useWorkspaceEnvStore.getState().setEnv({ kind: "local" }));

describe("Markdown file references", () => {
  it("hands an absolute file and line to workbench navigation", async () => {
    const container = document.createElement("div");
    const scrollContainer = document.createElement("div");
    const root = createRoot(container);
    const onOpen = vi.fn();
    mocks.invoke.mockResolvedValue({ kind: "file" });

    await act(async () =>
      root.render(
        <MarkdownDocumentRenderer
          document={prepareMarkdownDocument("[config](./config.ts:12)")}
          documentPath="D:/project/README.md"
          mode="dark"
          visible
          scrollContainer={scrollContainer}
          onFragmentNavigate={() => {}}
          onFileReferenceOpen={onOpen}
          onFileReferenceOpenDirectory={() => {}}
        />,
      ),
    );

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(
      "terax-file:D%3A%2Fproject%2Fconfig.ts%3A12",
    );
    expect(link?.textContent).toBe("config (line:12)");
    await act(async () => link?.click());
    expect(onOpen).toHaveBeenCalledWith("D:/project/config.ts", 12);

    await act(async () => root.unmount());
  });

  it("opens a remote directory from both the link and its context menu", async () => {
    useWorkspaceEnvStore.getState().setEnv({ kind: "ssh", profileId: "test" });
    const container = document.createElement("div");
    document.body.append(container);
    const scrollContainer = document.createElement("div");
    const root = createRoot(container);
    const onOpen = vi.fn();
    const onOpenDirectory = vi.fn();
    mocks.invoke.mockResolvedValue({ kind: "dir" });

    await act(async () =>
      root.render(
        <MarkdownDocumentRenderer
          document={prepareMarkdownDocument("[docs](./docs)")}
          documentPath="/workspace/README.md"
          mode="dark"
          visible
          scrollContainer={scrollContainer}
          onFragmentNavigate={() => {}}
          onFileReferenceOpen={onOpen}
          onFileReferenceOpenDirectory={onOpenDirectory}
        />,
      ),
    );

    const link = container.querySelector("a");
    await act(async () => link?.click());
    expect(onOpenDirectory).toHaveBeenCalledWith("/workspace/docs");
    expect(onOpen).not.toHaveBeenCalled();

    await act(async () =>
      link?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, button: 2 }),
      ),
    );
    const openDirectory = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((item) => item.textContent === "spaces:openInNewSpace");
    expect(openDirectory).toBeDefined();
    await act(async () => openDirectory?.click());
    expect(onOpenDirectory).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
    container.remove();
  });
});

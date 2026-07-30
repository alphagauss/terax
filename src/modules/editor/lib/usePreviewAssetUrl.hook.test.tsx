/**
 * 本文件测试跨工作区媒体 URL 的异步生命周期。
 *
 * 锁定 WSL 路径先转换为宿主路径，以及 SSH object URL 在卸载时释放。
 */

// @vitest-environment happy-dom

import { usePreviewAssetUrl } from "@/modules/editor/lib/usePreviewAssetUrl";
import type { WorkspaceEnv } from "@/modules/workspace";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => tauri);

function PreviewAssetHarness({
  path,
  workspace,
}: {
  path: string;
  workspace: WorkspaceEnv;
}) {
  const asset = usePreviewAssetUrl(path, workspace, true);
  return <output data-url={asset.url ?? ""} data-error={asset.error ?? ""} />;
}

beforeEach(() => {
  tauri.convertFileSrc.mockClear();
  tauri.invoke.mockReset();
});

describe("usePreviewAssetUrl", () => {
  it("canonicalizes WSL paths before creating an asset URL", async () => {
    tauri.invoke.mockResolvedValue("C:\\workspace\\image.png");
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <PreviewAssetHarness
          path="/workspace/image.png"
          workspace={{ kind: "wsl", distro: "Ubuntu" }}
        />,
      );
    });

    expect(tauri.invoke).toHaveBeenCalledWith("fs_canonicalize", {
      path: "/workspace/image.png",
      workspace: { kind: "wsl", distro: "Ubuntu" },
    });
    expect(container.querySelector("output")?.dataset.url).toBe(
      "asset://C:\\workspace\\image.png",
    );
    act(() => root.unmount());
  });

  it("revokes the SSH object URL when the consumer unmounts", async () => {
    tauri.invoke.mockResolvedValue({ bytes: [137, 80, 78, 71], size: 4 });
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:markdown-image");
    const revokeObjectUrl = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <PreviewAssetHarness
          path="/workspace/image.png"
          workspace={{ kind: "ssh", profileId: "server" }}
        />,
      );
    });
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(container.querySelector("output")?.dataset.url).toBe(
      "blob:markdown-image",
    );

    act(() => root.unmount());
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:markdown-image");
    createObjectUrl.mockRestore();
    revokeObjectUrl.mockRestore();
  });
});

/**
 * 本文件测试 Markdown 图片原生资源引用生命周期。
 *
 * 锁定按需 prepare、asset URL 转换和卸载 release，避免远端临时资源泄漏。
 */

// @vitest-environment happy-dom

import {
  isNetworkMarkdownImageSource,
  type MarkdownImageSource,
  useMarkdownImageAsset,
} from "@/modules/markdown/lib/imageResources";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => tauri);

function ImageAssetHarness({
  source,
  enabled,
}: {
  source: MarkdownImageSource;
  enabled: boolean;
}) {
  const asset = useMarkdownImageAsset(source, enabled);
  return <output data-url={asset.url ?? ""} data-error={asset.error ?? ""} />;
}

beforeEach(() => {
  tauri.convertFileSrc.mockClear();
  tauri.invoke.mockReset();
});

describe("useMarkdownImageAsset", () => {
  it("prepares once and releases the returned resource on unmount", async () => {
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "markdown_image_prepare") {
        return Promise.resolve({
          token: "image-token",
          path: "C:\\Temp\\image.png",
        });
      }
      return Promise.resolve();
    });
    const source: MarkdownImageSource = {
      kind: "network",
      url: "https://example.com/image.png",
      userAgent: "test",
    };
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(<ImageAssetHarness source={source} enabled />);
    });
    expect(tauri.invoke).toHaveBeenCalledWith("markdown_image_prepare", {
      source,
    });
    expect(container.querySelector("output")?.dataset.url).toBe(
      "asset://C:\\Temp\\image.png",
    );

    await act(async () => root.unmount());
    expect(tauri.invoke).toHaveBeenCalledWith("markdown_image_release", {
      token: "image-token",
    });
  });

  it("shares one native resource through a Strict Mode remount", async () => {
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "markdown_image_prepare") {
        return Promise.resolve({
          token: "strict-token",
          path: "C:\\Temp\\strict.png",
        });
      }
      return Promise.resolve();
    });
    const source: MarkdownImageSource = {
      kind: "network",
      url: "https://example.com/strict.png",
      userAgent: "test",
    };
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <StrictMode>
          <ImageAssetHarness source={source} enabled />
        </StrictMode>,
      );
    });
    expect(
      tauri.invoke.mock.calls.filter(
        ([command]) => command === "markdown_image_prepare",
      ),
    ).toHaveLength(1);

    await act(async () => root.unmount());
    expect(
      tauri.invoke.mock.calls.filter(
        ([command]) => command === "markdown_image_release",
      ),
    ).toHaveLength(1);
  });

  it("does not expose a released token while reacquiring the same source", async () => {
    let prepareCount = 0;
    let resolveSecond:
      | ((resource: { token: string; path: string }) => void)
      | undefined;
    tauri.invoke.mockImplementation((command: string) => {
      if (command !== "markdown_image_prepare") return Promise.resolve();
      prepareCount += 1;
      if (prepareCount === 1) {
        return Promise.resolve({
          token: "first-token",
          path: "C:\\Temp\\first.png",
        });
      }
      return new Promise((resolve) => {
        resolveSecond = resolve;
      });
    });
    const source: MarkdownImageSource = {
      kind: "network",
      url: "https://example.com/reacquire.png",
      userAgent: "test",
    };
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(<ImageAssetHarness source={source} enabled />);
    });
    expect(container.querySelector("output")?.dataset.url).toContain(
      "first.png",
    );

    await act(async () => {
      root.render(<ImageAssetHarness source={source} enabled={false} />);
    });
    await act(async () => {
      root.render(<ImageAssetHarness source={source} enabled />);
    });
    expect(container.querySelector("output")?.dataset.url).toBe("");

    await act(async () => {
      resolveSecond?.({
        token: "second-token",
        path: "C:\\Temp\\second.png",
      });
    });
    expect(container.querySelector("output")?.dataset.url).toContain(
      "second.png",
    );
    await act(async () => root.unmount());
  });

  it("does not prepare a disabled resource", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(
        <ImageAssetHarness
          source={{
            kind: "workspace",
            path: "/repo/image.png",
            workspace: { kind: "local" },
          }}
          enabled={false}
        />,
      );
    });
    expect(tauri.invoke).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});

describe("isNetworkMarkdownImageSource", () => {
  it("accepts only HTTP and HTTPS URLs", () => {
    expect(isNetworkMarkdownImageSource("https://example.com/a.png")).toBe(
      true,
    );
    expect(isNetworkMarkdownImageSource("HTTP://example.com/a.png")).toBe(true);
    expect(isNetworkMarkdownImageSource("data:image/png;base64,AA==")).toBe(
      false,
    );
    expect(isNetworkMarkdownImageSource("./a.png")).toBe(false);
  });
});

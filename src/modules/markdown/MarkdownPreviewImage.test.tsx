/**
 * 本文件测试 Markdown 图片的延迟加载边界。
 *
 * 锁定隐藏标签页不观察图片，以及相对和网络图片接近视口后才准备资源。
 */

// @vitest-environment happy-dom

import {
  MarkdownImageProvider,
  MarkdownPreviewImage,
} from "@/modules/markdown/MarkdownPreviewImage";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  useMarkdownImageAsset: vi.fn(
    (
      source: { kind: string; path?: string; url?: string },
      enabled: boolean,
    ) => ({
      resource: enabled
        ? {
            token: "token",
            path: source.path ?? source.url ?? "",
          }
        : null,
      url: enabled ? `asset://${source.path ?? source.url ?? ""}` : null,
      error: null,
    }),
  ),
}));

vi.mock("@/modules/markdown/lib/imageResources", () => ({
  isNetworkMarkdownImageSource: (src: string) => /^https?:\/\//i.test(src),
  useMarkdownImageAsset: testState.useMarkdownImageAsset,
}));
vi.mock("@/modules/workspace", () => ({
  useWorkspaceEnvStore: (
    selector: (state: { env: { kind: "local" } }) => unknown,
  ) => selector({ env: { kind: "local" } }),
}));

type ObserverCallback = IntersectionObserverCallback;

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];

  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();

  constructor(
    readonly callback: ObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    TestIntersectionObserver.instances.push(this);
  }
}

beforeEach(() => {
  testState.useMarkdownImageAsset.mockClear();
  TestIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
});

describe("MarkdownPreviewImage", () => {
  it("loads a relative image only after it becomes visible and near viewport", () => {
    const container = document.createElement("div");
    const scrollRoot = document.createElement("section");
    const root = createRoot(container);
    const source = "terax-relative-image:.%2Fassets%2Fchart.png";

    act(() => {
      root.render(
        createElement(
          MarkdownImageProvider,
          {
            documentPath: "/repo/docs/readme.md",
            scrollRoot,
            visible: false,
          },
          createElement(MarkdownPreviewImage, {
            src: source,
            alt: "Chart",
          }),
        ),
      );
    });
    expect(TestIntersectionObserver.instances).toHaveLength(0);
    act(() => {
      root.render(
        createElement(
          MarkdownImageProvider,
          {
            documentPath: "/repo/docs/readme.md",
            scrollRoot,
            visible: true,
          },
          createElement(MarkdownPreviewImage, {
            src: source,
            alt: "Chart",
          }),
        ),
      );
    });
    expect(TestIntersectionObserver.instances).toHaveLength(1);
    expect(TestIntersectionObserver.instances[0]?.options?.root).toBe(
      scrollRoot,
    );
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBeNull();
    expect(testState.useMarkdownImageAsset).toHaveBeenLastCalledWith(
      {
        kind: "workspace",
        path: "/repo/docs/assets/chart.png",
        workspace: { kind: "local" },
      },
      false,
    );

    act(() => {
      TestIntersectionObserver.instances[0]?.callback(
        [
          {
            isIntersecting: true,
            target: image,
          } as unknown as IntersectionObserverEntry,
        ],
        TestIntersectionObserver
          .instances[0] as unknown as IntersectionObserver,
      );
    });
    expect(image?.getAttribute("src")).toBe(
      "asset:///repo/docs/assets/chart.png",
    );
    expect(testState.useMarkdownImageAsset).toHaveBeenLastCalledWith(
      {
        kind: "workspace",
        path: "/repo/docs/assets/chart.png",
        workspace: { kind: "local" },
      },
      true,
    );
    act(() => root.unmount());
  });

  it("prepares a network image through the same lazy resource path", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => {
      root.render(
        createElement(MarkdownPreviewImage, {
          src: "https://example.com/chart.png",
          alt: "Chart",
        }),
      );
    });
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBeNull();
    expect(TestIntersectionObserver.instances).toHaveLength(1);

    act(() => {
      TestIntersectionObserver.instances[0]?.callback(
        [
          {
            isIntersecting: true,
            target: image,
          } as unknown as IntersectionObserverEntry,
        ],
        TestIntersectionObserver
          .instances[0] as unknown as IntersectionObserver,
      );
    });
    expect(image?.getAttribute("src")).toBe(
      "asset://https://example.com/chart.png",
    );
    expect(testState.useMarkdownImageAsset).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "network",
        url: "https://example.com/chart.png",
      }),
      true,
    );
    act(() => root.unmount());
  });
});

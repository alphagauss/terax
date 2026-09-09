// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import Screenshots from "react-screenshots";
import { expect, it, vi } from "vitest";

it("使用源图像素导出，并保留由宿主决定何时结束的选区", async () => {
  const images: HTMLImageElement[] = [];
  const exported: number[][] = [];
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    tag: string,
    options?: ElementCreationOptions,
  ) => {
    const element = createElement(tag, options);
    if (tag === "img") {
      Object.defineProperties(element, {
        naturalWidth: { value: 3840 },
        naturalHeight: { value: 2160 },
      });
      images.push(element as HTMLImageElement);
    }
    return element;
  }) as typeof document.createElement);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      return new Proxy(
        { canvas: this },
        { get: (target, key) => (key === "canvas" ? target.canvas : vi.fn()) },
      );
    } as never,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
  ) {
    exported.push([this.width, this.height]);
    callback(new Blob(["png"], { type: "image/png" }));
  });
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    value: 1,
  });
  const container = createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const saved = vi.fn();
  try {
    await act(async () =>
      root.render(
        <Screenshots
          url="blob:source"
          width={1920}
          height={1080}
          onSave={saved}
        />,
      ),
    );
    await act(async () => {
      for (const image of images) image.dispatchEvent(new Event("load"));
    });
    const background = container.querySelector(
      ".screenshots-background",
    ) as HTMLElement;
    await act(async () => {
      background.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 10,
          clientY: 20,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { clientX: 110, clientY: 70 }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", { clientX: 110, clientY: 70 }),
      );
    });
    const selection = container.querySelector<HTMLElement>(
      ".screenshots-canvas",
    );
    expect(selection?.style.width).toBe("100px");
    await act(async () => {
      container.querySelector(".icon-save")?.parentElement?.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(saved).toHaveBeenCalledOnce();
    expect(exported).toEqual([[200, 100]]);
    expect(selection?.style.width).toBe("100px");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  }
});

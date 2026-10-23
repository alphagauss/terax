// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SegmentedControl } from "@/components/controls/segmented-control";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let animations: Animation[];
let animate: ReturnType<typeof vi.fn<HTMLElement["animate"]>>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  animations = [];
  animate = vi.fn(() => {
    const animation = {
      cancel: vi.fn(),
      onfinish: null,
      oncancel: null,
    } as unknown as Animation;
    animations.push(animation);
    return animation;
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 96, 32),
  ] as unknown as DOMRectList);
  HTMLElement.prototype.animate = animate;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  vi.unstubAllGlobals();
});

function render(value: string) {
  act(() =>
    root.render(
      <SegmentedControl
        value={value}
        label="Network"
        options={[
          ["system", "System"],
          ["proxy", "Proxy"],
          ["direct", "Direct"],
        ]}
        onValueChange={() => {}}
      />,
    ),
  );
}

it("首次直接定位，反向切换从当前视觉位置继续，隐藏和卸载清理动画", () => {
  render("system");
  expect(animate).not.toHaveBeenCalled();
  render("direct");
  expect(animate).toHaveBeenCalledTimes(1);
  const getStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const style = getStyle(element);
    if (element === host.querySelector("span[aria-hidden]"))
      return new Proxy(style, {
        get: (target, key) =>
          key === "transform"
            ? "matrix(1, 0, 0, 1, 80, 0)"
            : Reflect.get(target, key),
      });
    return style;
  });
  render("proxy");
  expect(animations[0].cancel).toHaveBeenCalledOnce();
  expect(animate.mock.calls[1][0]).toEqual([
    { transform: "matrix(1, 0, 0, 1, 80, 0)" },
    { transform: "translateX(100%)" },
  ]);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(animations[1].cancel).toHaveBeenCalledOnce();
  render("direct");
  expect(animate).toHaveBeenCalledTimes(2);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  render("system");
  act(() => root.render(null));
  expect(animations[2].cancel).toHaveBeenCalledOnce();
});

it("减少动态效果时直接更新选中位置", () => {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) => ({ matches: true, media: query }) as MediaQueryList,
  );
  render("system");
  render("direct");
  expect(animate).not.toHaveBeenCalled();
  expect(
    host.querySelector<HTMLElement>("span[aria-hidden]")?.style.transform,
  ).toBe("translateX(200%)");
});

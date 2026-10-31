// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useNavigationIndicator } from "@/components/controls/use-navigation-indicator";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let animate: ReturnType<typeof vi.fn<HTMLElement["animate"]>>;
let animations: Animation[];
let resize: () => void;
let horizontal: boolean;
let visible: boolean;
let offset: number;
let zoom: number;

function Harness({
  active,
  layout,
  tabs,
}: {
  active: string | null;
  layout: string;
  tabs: boolean;
}) {
  const { hostRef, indicatorRef } = useNavigationIndicator(active, layout);
  return (
    <div ref={hostRef} data-navigation>
      <span ref={indicatorRef} data-indicator style={{ opacity: 0 }} />
      {["files", "search", "git"].map((id, index) => (
        <div key={id} data-item-index={index}>
          {tabs ? (
            <button
              type="button"
              role="tab"
              aria-selected={active === id}
              data-navigation-indicator-target={index}
            >
              {id}
            </button>
          ) : (
            <button type="button" aria-pressed={active === id}>
              <span data-navigation-indicator-target={index} />
              {id}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function render(active: string | null, layout = "vertical", tabs = false) {
  act(() =>
    root.render(<Harness active={active} layout={layout} tabs={tabs} />),
  );
}

function indicator() {
  const element = host.querySelector<HTMLElement>("[data-indicator]");
  if (!element) throw new Error("选中底块未挂载");
  return element;
}

function sampleVisual(transform: string, opacity = "1") {
  const getStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const style = getStyle(element);
    return element === indicator()
      ? new Proxy(style, {
          get: (target, key) =>
            key === "transform"
              ? transform
              : key === "opacity"
                ? opacity
                : Reflect.get(target, key),
        })
      : style;
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  horizontal = false;
  visible = true;
  offset = 0;
  zoom = 1;
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (!visible) return new DOMRect();
      const index = this.getAttribute("data-navigation-indicator-target");
      if (index === null)
        return new DOMRect(100 * zoom, 200 * zoom, 44 * zoom, 300 * zoom);
      return horizontal
        ? new DOMRect(
            (100 + Number(index) * 80 + offset) * zoom,
            200 * zoom,
            (80 + Number(index) * 10) * zoom,
            28 * zoom,
          )
        : new DOMRect(
            104 * zoom,
            (204 + Number(index) * 48 + offset) * zoom,
            36 * zoom,
            40 * zoom,
          );
    },
  );
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      return visible ? this.parentElement : null;
    },
  });
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(
    function (this: HTMLElement) {
      if (this.hasAttribute("data-navigation-indicator-target"))
        return horizontal ? 0 : 4;
      const index = this.getAttribute("data-item-index");
      return horizontal && index !== null ? Number(index) * 80 + offset : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(
    function (this: HTMLElement) {
      if (this.hasAttribute("data-navigation-indicator-target"))
        return horizontal ? 0 : 4;
      const index = this.getAttribute("data-item-index");
      return !horizontal && index !== null ? Number(index) * 48 + offset : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return visible
        ? horizontal
          ? 80 +
            Number(this.getAttribute("data-navigation-indicator-target")) * 10
          : 36
        : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    () => (visible ? (horizontal ? 28 : 40) : 0),
  );
  HTMLElement.prototype.animate = animate;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  Reflect.deleteProperty(HTMLElement.prototype, "offsetParent");
  vi.unstubAllGlobals();
});

it("首次直接定位，连续切换接续当前底块，尺寸观测不打断相同几何的动画", () => {
  render("files");
  expect(animate).not.toHaveBeenCalled();
  expect(indicator().style.transform).toBe("translate(4px, 4px)");
  render("git");
  resize();
  expect(animations[0].cancel).not.toHaveBeenCalled();
  sampleVisual("matrix(1, 0, 0, 1, 4, 64)");
  render("search");
  expect(animations[0].cancel).toHaveBeenCalledOnce();
  expect(animate.mock.calls[1][0]).toEqual([
    { transform: "matrix(1, 0, 0, 1, 4, 64) scale(1, 1)" },
    { transform: "translate(4px, 52px)" },
  ]);
});

it("取消立即更新语义，仅底块淡出，完成后无选中到选中直接定位", () => {
  render("files");
  render(null);
  expect(host.querySelector('[aria-pressed="true"]')).toBeNull();
  expect(indicator().style.visibility).toBe("visible");
  expect(animate.mock.calls[0]).toEqual([
    [{ opacity: "1" }, { opacity: 0 }],
    expect.objectContaining({ duration: 160 }),
  ]);
  animations[0].onfinish?.call(animations[0], {} as AnimationPlaybackEvent);
  expect(indicator().style.visibility).toBe("hidden");
  render("search");
  expect(animate).toHaveBeenCalledTimes(1);
  expect(indicator().style.opacity).toBe("1");
});

it("淡出中重新选中从当前透明度和位置继续，取消旧退出不会隐藏新底块", () => {
  render("files");
  render(null);
  sampleVisual("matrix(1, 0, 0, 1, 4, 4)", "0.4");
  render("git");
  expect(animations[0].cancel).toHaveBeenCalledOnce();
  expect(animations[0].onfinish).toBeNull();
  expect(animate.mock.calls[1][0]).toEqual([
    { transform: "matrix(1, 0, 0, 1, 4, 4) scale(1, 1)", opacity: "0.4" },
    { transform: "translate(4px, 100px)", opacity: 1 },
  ]);
  expect(indicator().style.visibility).toBe("visible");
});

it("滑动中取消停留在当前视觉位置淡出，不跳到旧目标", () => {
  render("files");
  render("git");
  sampleVisual("matrix(1, 0, 0, 1, 4, 64)");
  render(null);
  expect(animations[0].cancel).toHaveBeenCalledOnce();
  expect(indicator().style.transform).toBe("matrix(1, 0, 0, 1, 4, 64)");
  expect(animate.mock.calls[1][0]).toEqual([{ opacity: "1" }, { opacity: 0 }]);
});

it.each([false, true])(
  "横向不等宽导航（Tab：%s）只缩放底块，位置或尺寸改变直接提交",
  (tabs) => {
    horizontal = true;
    render("files", "horizontal", tabs);
    render("git", "horizontal", tabs);
    if (tabs) {
      expect(
        host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
      ).toBe("git");
      expect(host.querySelector('[aria-pressed="true"]')).toBeNull();
    }
    expect(animate.mock.calls[0][0]).toEqual([
      { transform: "translate(0px, 0px) scale(0.8, 1)" },
      { transform: "translate(160px, 0px)" },
    ]);
    offset = 10;
    resize();
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expect(indicator().style.transform).toBe("translate(170px, 0px)");
    render("search", "compact", tabs);
    expect(animate).toHaveBeenCalledTimes(1);
  },
);

it.each([0.8, 1.25, 1.5])(
  "UI 缩放为 %s 时底块仍使用布局坐标，不重复应用缩放",
  (scale) => {
    zoom = scale;
    render("git");
    expect(indicator().style.transform).toBe("translate(4px, 100px)");
    expect(indicator().style.width).toBe("36px");
    expect(indicator().style.height).toBe("40px");
  },
);

it("隐藏恢复、窗口隐藏与卸载清理动画且恢复时直接定位", () => {
  render("files");
  render("git");
  visible = false;
  resize();
  expect(animations[0].cancel).toHaveBeenCalledOnce();
  expect(indicator().style.visibility).toBe("hidden");
  visible = true;
  resize();
  expect(indicator().style.visibility).toBe("visible");
  render("search");
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(animations[1].cancel).toHaveBeenCalledOnce();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  render("files");
  expect(animate).toHaveBeenCalledTimes(2);
  render("git");
  act(() => root.render(null));
  expect(animations[2].cancel).toHaveBeenCalledOnce();
});

it("减少动态效果时切换与取消都直接提交", () => {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) => ({ matches: true, media: query }) as MediaQueryList,
  );
  render("files");
  render("git");
  render(null);
  expect(animate).not.toHaveBeenCalled();
  expect(indicator().style.visibility).toBe("hidden");
});

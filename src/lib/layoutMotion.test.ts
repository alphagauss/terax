// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LayoutMotion } from "@/lib/layoutMotion";

let root: HTMLDivElement;
let first: HTMLElement;
let second: HTMLElement;
let layout: LayoutMotion;
let notify: () => void;
let height: number;
let animations: {
  element: HTMLElement;
  frames: Keyframe[];
  animation: Animation;
}[];

beforeEach(() => {
  height = 100;
  animations = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  root = document.createElement("div");
  root.innerHTML =
    "<div><div data-error-surface></div></div><div><div data-error-surface></div></div>";
  document.body.append(root);
  [first, second] = Array.from(root.children) as HTMLElement[];
  for (const element of [root, first, second]) {
    vi.spyOn(element, "getClientRects").mockReturnValue([
      new DOMRect(),
    ] as unknown as DOMRectList);
    Object.defineProperty(element, "offsetHeight", {
      configurable: true,
      get: () =>
        element === first ? height : element === second ? 100 : height + 100,
    });
    Object.defineProperty(element, "offsetWidth", {
      configurable: true,
      value: 380,
    });
    Object.defineProperty(element, "offsetTop", {
      configurable: true,
      get: () => (element === second ? height : 0),
    });
    vi.spyOn(element, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, element.offsetTop, 380, element.offsetHeight),
    );
  }
  HTMLElement.prototype.animate = vi.fn(function (
    this: HTMLElement,
    frames: Keyframe[] | PropertyIndexedKeyframes | null,
  ) {
    const animation = {
      cancel: vi.fn(),
      onfinish: null,
      oncancel: null,
    } as unknown as Animation;
    animations.push({ element: this, frames: frames as Keyframe[], animation });
    return animation;
  });
  layout = new LayoutMotion({
    surface: "[data-error-surface]",
    retainHeight: true,
  });
  layout.sync(root);
});

afterEach(() => {
  layout.disconnect();
  root.remove();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  vi.unstubAllGlobals();
});

function finish() {
  const animation = animations.find(
    ({ animation }) => animation.onfinish,
  )?.animation;
  animation?.onfinish?.call(animation, {} as AnimationPlaybackEvent);
}

it("详情改变高度时只缩放背景并移动后续卡片", () => {
  height = 200;
  notify();
  expect(animations.map(({ element }) => element)).toEqual([
    first.querySelector("[data-error-surface]"),
    second,
  ]);
  expect(animations[0].frames).toEqual([{ scale: "1 0.5" }, { scale: "1 1" }]);
  expect(animations[1].frames).toEqual([
    { translate: "0 -100px" },
    { translate: "0 0px" },
  ]);
  notify();
  expect(animations).toHaveLength(2);
  finish();
  expect(root.style.height).toBe("");
});

it("快速反向收起接续背景与位移进度，结束后释放会话", () => {
  height = 200;
  notify();
  const old = [...animations];
  const getStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    element === second
      ? ({ translate: "0px -40px" } as CSSStyleDeclaration)
      : element === first.querySelector("[data-error-surface]")
        ? ({ scale: "1 0.75" } as CSSStyleDeclaration)
        : getStyle(element),
  );
  height = 100;
  notify();
  expect(
    old.every(
      ({ animation }) => vi.mocked(animation.cancel).mock.calls.length === 1,
    ),
  ).toBe(true);
  expect(animations[2].frames).toEqual([{ scale: "1 1.5" }, { scale: "1 1" }]);
  expect(animations[3].frames).toEqual([
    { translate: "0 60px" },
    { translate: "0 0px" },
  ]);
  expect(root.style.height).toBe("300px");
  finish();
  expect(root.style.height).toBe("");
});

it.each(["scroll", "resize", "visibilitychange", "disconnect"])(
  "%s 结束旧几何并清理临时尺寸",
  (reason) => {
    height = 200;
    notify();
    if (reason === "disconnect") layout.disconnect();
    else if (reason === "visibilitychange")
      document.dispatchEvent(new Event(reason));
    else window.dispatchEvent(new Event(reason));
    expect(
      animations.every(
        ({ animation }) => vi.mocked(animation.cancel).mock.calls.length === 1,
      ),
    ).toBe(true);
    expect(root.style.height).toBe("");
  },
);

it("减少动态效果时直接提交尺寸，不创建布局动画", () => {
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: true,
  } as MediaQueryList);
  height = 200;
  notify();
  expect(animations).toHaveLength(0);
  expect(root.style.height).toBe("");
});

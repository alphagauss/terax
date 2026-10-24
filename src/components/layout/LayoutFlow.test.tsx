// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LayoutFlow } from "@/components/layout/LayoutFlow";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let frames: Map<number, FrameRequestCallback>;
let observers: Set<{ notify: () => void; targets: Set<Element> }>;
let animations: {
  element: HTMLElement;
  frames: Keyframe[];
  animation: Animation;
}[];
let media: MediaQueryList;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  frames = new Map();
  observers = new Set();
  animations = [];
  let frameId = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets = new Set<Element>();
      constructor(public notify: () => void) {
        observers.add(this);
      }
      observe(element: Element) {
        this.targets.add(element);
      }
      unobserve(element: Element) {
        this.targets.delete(element);
      }
      disconnect() {
        observers.delete(this);
      }
    },
  );
  media = Object.assign(new EventTarget(), {
    matches: false,
  }) as MediaQueryList;
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(),
  ] as unknown as DOMRectList);
  HTMLElement.prototype.animate = vi.fn(function (
    this: HTMLElement,
    keyframes,
  ) {
    const animation = {
      cancel: vi.fn(),
      onfinish: null,
      oncancel: null,
    } as unknown as Animation;
    animations.push({
      element: this,
      frames: keyframes as Keyframe[],
      animation,
    });
    return animation;
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const pending = [...frames.values()];
  frames.clear();
  act(() => {
    for (const callback of pending) callback(0);
  });
}

function finish() {
  for (const { animation } of animations)
    animation.onfinish?.call(animation, {} as AnimationPlaybackEvent);
}

/** 模拟最终布局，验证动画接续和实例生命周期，不替代 WebView 的真实排版。 */
async function fixture() {
  let state = {
    short: false,
    reverse: false,
    extra: false,
    offset: 0,
    active: true,
  };
  let width = 620;
  const click = vi.fn();
  const view = () => (
    <div style={{ overflow: "auto" }}>
      <LayoutFlow active={state.active} className="flex flex-wrap gap-2">
        {(state.reverse
          ? ["input", "action", "source"]
          : ["source", "action", "input"]
        ).map((id) =>
          id === "input" ? (
            <input key={id} data-id={id} defaultValue="保留草稿" />
          ) : (
            <button type="button" key={id} data-id={id} onClick={click}>
              {id === "source" && state.short ? "短" : id}
            </button>
          ),
        )}
        {state.extra && (
          <button type="button" data-id="extra">
            新增
          </button>
        )}
        <input aria-hidden="true" tabIndex={-1} />
      </LayoutFlow>
    </div>
  );
  act(() => root.render(view()));
  const viewport = host.firstElementChild as HTMLElement;
  const flow = viewport.firstElementChild as HTMLElement;
  const controls = () => [...flow.querySelectorAll<HTMLElement>("[data-id]")];
  const itemWidth = (element: HTMLElement) =>
    element.dataset.id === "source" ? (state.short ? 60 : 180) : 80;
  const wire = () => {
    for (const element of controls())
      Object.defineProperties(element, {
        offsetLeft: {
          configurable: true,
          get: () => {
            const items = controls().sort(
              (a, b) => Number(a.style.order) - Number(b.style.order),
            );
            const inset = flow.style.justifyContent === "center" ? 100 : 0;
            if (state.offset && element.dataset.id !== "source") return inset;
            return (
              inset +
              items
                .slice(0, items.indexOf(element))
                .reduce((sum, item) => sum + itemWidth(item) + 8, 0)
            );
          },
        },
        offsetTop: {
          configurable: true,
          get: () => (element.dataset.id === "source" ? 0 : state.offset),
        },
        offsetWidth: { configurable: true, get: () => itemWidth(element) },
        offsetHeight: { configurable: true, value: 32 },
      });
  };
  Object.defineProperty(flow, "clientWidth", { get: () => width });
  flow.getBoundingClientRect = () =>
    new DOMRect(0, 20, width, 32 + state.offset);
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, width, 120);
  wire();
  window.dispatchEvent(new Event("resize"));
  return {
    flow,
    click,
    control: (id: string) => {
      const control = flow.querySelector<HTMLElement>(`[data-id="${id}"]`);
      if (!control) throw new Error(`缺少控件 ${id}`);
      return control;
    },
    resize: () => {
      width = 500;
    },
    render: async (changes: Partial<typeof state>, resizeNotify = true) => {
      state = { ...state, ...changes };
      act(() => root.render(view()));
      wire();
      if (resizeNotify) for (const observer of observers) observer.notify();
      await flush();
    },
  };
}

it("宽度变化平滑补位且不缩放正文，同尺寸更新保留焦点、草稿、选区和点击", async () => {
  const f = await fixture();
  const input = f.control("input") as HTMLInputElement;
  input.focus();
  input.setSelectionRange(1, 3);
  expect(animations).toHaveLength(0);
  await f.render({ short: true });
  expect(
    animations.find((a) => a.element === f.control("action"))?.frames,
  ).toEqual([{ translate: "120px 0px" }, { translate: "0px 0px" }]);
  const count = animations.length;
  await f.render({ short: true });
  expect(animations).toHaveLength(count);
  expect(f.control("input")).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("保留草稿");
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);
  f.control("action").click();
  expect(f.click).toHaveBeenCalledOnce();
  expect(
    animations.every((a) =>
      a.frames.every((frame) => Object.keys(frame).join() === "translate"),
    ),
  ).toBe(true);
});

it("反向变化接续视觉位置，换行和无尺寸变化的换序、对齐也能补位", async () => {
  const f = await fixture();
  await f.render({ short: true });
  const old = [...animations];
  const getStyle = window.getComputedStyle.bind(window);
  const visualStyle = vi
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) =>
      element === f.control("action")
        ? new Proxy(getStyle(element), {
            get: (target, key) =>
              key === "translate" ? "60px 0px" : Reflect.get(target, key),
          })
        : getStyle(element),
    );
  await f.render({ short: false });
  expect(
    old.every((a) => vi.mocked(a.animation.cancel).mock.calls.length === 1),
  ).toBe(true);
  expect(
    [...animations].reverse().find((a) => a.element === f.control("action"))
      ?.frames[0],
  ).toEqual({ translate: "-60px 0px" });
  visualStyle.mockRestore();
  finish();
  await f.render({ offset: 40 });
  expect(
    [...animations].reverse().find((a) => a.element === f.control("action"))
      ?.frames[0],
  ).toEqual({ translate: "188px -40px" });
  finish();
  await f.render({ offset: 0 });
  finish();
  const count = animations.length;
  await f.render({ reverse: true }, false);
  expect(animations.length).toBeGreaterThan(count);
  finish();
  f.flow.style.justifyContent = "center";
  await flush();
  expect(
    [...animations].reverse().find((a) => a.element === f.control("source"))
      ?.frames[0],
  ).toEqual({ translate: "-100px 0px" });
});

it("增删只观察直接子项，新项直接定位，移除和停用清理观察与帧任务", async () => {
  const f = await fixture();
  expect([...observers][0].targets.size).toBe(4);
  await f.render({ extra: true });
  expect([...observers][0].targets.size).toBe(5);
  expect(animations.some((a) => a.element === f.control("extra"))).toBe(false);
  await f.render({ extra: false, short: true });
  expect([...observers][0].targets.size).toBe(4);
  await f.render({ active: false });
  expect(observers.size).toBe(0);
  expect(frames.size).toBe(0);
  expect(
    animations.every(
      (a) => vi.mocked(a.animation.cancel).mock.calls.length === 1,
    ),
  ).toBe(true);
  const count = animations.length;
  await f.render({ short: false, active: true });
  expect(animations).toHaveLength(count);
});

it("直接子项的 CSS 换序和语义隐藏不依赖尺寸通知", async () => {
  const f = await fixture();
  f.control("source").style.order = "1";
  await flush();
  expect(
    animations.find((a) => a.element === f.control("action"))?.frames[0],
  ).toEqual({ translate: "188px 0px" });
  f.control("input").setAttribute("aria-hidden", "true");
  await flush();
  expect([...observers][0].targets.has(f.control("input"))).toBe(false);
});

it("长距离位移限制在局部滚动视口，滚动和容器变宽结束旧几何", async () => {
  const f = await fixture();
  await f.render({ offset: 1000 });
  finish();
  await f.render({ offset: 40 });
  expect(
    [...animations].reverse().find((a) => a.element === f.control("action"))
      ?.frames[0],
  ).toEqual({ translate: "0 60px" });
  f.control("action").dispatchEvent(new Event("scroll"));
  expect(
    animations.some(
      (a) => vi.mocked(a.animation.cancel).mock.calls.length === 0,
    ),
  ).toBe(true);
  host.firstElementChild?.dispatchEvent(new Event("scroll"));
  expect(
    animations.every(
      (a) => vi.mocked(a.animation.cancel).mock.calls.length === 1,
    ),
  ).toBe(true);
  const count = animations.length;
  f.resize();
  await f.render({ short: true });
  expect(animations).toHaveLength(count);
});

it("窗口隐藏和减少动态效果立即清理，恢复时不补播", async () => {
  const f = await fixture();
  await f.render({ short: true });
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(observers.size).toBe(0);
  await f.render({ short: false });
  const count = animations.length;
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event("visibilitychange"));
  await f.render({});
  expect(animations).toHaveLength(count);
  await f.render({ short: true });
  Object.defineProperty(media, "matches", { value: true, configurable: true });
  media.dispatchEvent(new Event("change"));
  expect(
    animations.every(
      (a) => vi.mocked(a.animation.cancel).mock.calls.length === 1,
    ),
  ).toBe(true);
  const reducedCount = animations.length;
  await f.render({ short: false });
  expect(animations).toHaveLength(reducedCount);
});

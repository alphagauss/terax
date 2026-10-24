// @vitest-environment happy-dom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContentReveal } from "@/components/controls/content-reveal";

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
  HTMLElement.prototype.animate = animate;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const height = this.style.height
        ? Number.parseFloat(this.style.height)
        : Number(
            this.querySelector("[data-size]")?.getAttribute("data-size") ?? 0,
          );
      return new DOMRect(0, 0, 200, height);
    },
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  vi.unstubAllGlobals();
});

function render(open: boolean, key = "a", height = 100) {
  act(() =>
    root.render(
      <ContentReveal open={open} transitionKey={key}>
        <div key={key} data-size={height}>
          <input defaultValue={key} />
        </div>
      </ContentReveal>,
    ),
  );
}
function finish() {
  const animation = animations.find((item) => item.onfinish);
  act(() => animation?.onfinish?.call(animation, {} as AnimationPlaybackEvent));
}

it("退出期间保留原输入实例且禁止交互，反向打开不重挂载，结束后释放退出树", () => {
  render(true);
  const input = host.querySelector("input");
  render(false);
  expect(host.querySelector("input")).toBe(input);
  expect(input?.closest("[inert]")).not.toBeNull();
  const previous = [...animations];
  render(true);
  expect(host.querySelector("input")).toBe(input);
  for (const animation of previous)
    expect(animation.cancel).toHaveBeenCalledOnce();
  finish();
  expect(host.querySelector<HTMLElement>("[data-state]")?.style.height).toBe(
    "",
  );
  render(false);
  finish();
  expect(host.querySelector("input")).toBeNull();
  expect(host.querySelector("[style*='position: absolute']")).toBeNull();
});

it("模型切换仅在高度改变时揭示，不因参数选值更新重播", () => {
  render(true, "a", 100);
  render(true, "b", 100);
  expect(animate).not.toHaveBeenCalled();
  render(true, "c", 200);
  expect(animate).toHaveBeenCalledTimes(2);
  expect(host.querySelector("input")).not.toBeNull();
  const current = [...animations];
  render(true, "c", 200);
  expect(animate).toHaveBeenCalledTimes(2);
  expect(current[0].cancel).not.toHaveBeenCalled();
  finish();
  expect(host.querySelector<HTMLElement>("[data-state]")?.style.height).toBe(
    "",
  );
});

it("明确边界内原本在屏外的后续内容也接续位移，边界外内容不参与", () => {
  const renderPanel = (size: number) =>
    act(() =>
      root.render(
        <>
          <section data-reveal-boundary>
            <ContentReveal open transitionKey={String(size)}>
              <div data-size={size} />
            </ContentReveal>
            <div data-follower />
          </section>
          <div data-outside />
        </>,
      ),
    );
  renderPanel(2000);
  const follower = host.querySelector<HTMLElement>("[data-follower]");
  if (!follower) throw new Error("缺少后续内容");
  follower.getBoundingClientRect = () =>
    new DOMRect(
      0,
      Number(host.querySelector("[data-size]")?.getAttribute("data-size")),
      200,
      20,
    );
  renderPanel(100);
  expect(animate.mock.contexts).toContain(follower);
  expect(animate.mock.contexts).not.toContain(
    host.querySelector("[data-outside]"),
  );
  finish();
});

it("排列宿主拥有卡片补位，内部揭示不重复移动相邻卡片", () => {
  const renderCards = (size: number) =>
    act(() =>
      root.render(
        <section data-reveal-boundary>
          <div data-layout-flow>
            <div>
              <ContentReveal open transitionKey={String(size)}>
                <div data-size={size} />
              </ContentReveal>
              <div data-inside />
            </div>
            <div data-neighbor />
          </div>
          <div data-outside />
        </section>,
      ),
    );
  renderCards(100);
  const inside = host.querySelector<HTMLElement>("[data-inside]");
  if (!inside) throw new Error("缺少卡片内部后续内容");
  inside.getBoundingClientRect = () =>
    new DOMRect(
      0,
      Number(host.querySelector("[data-size]")?.getAttribute("data-size")),
      200,
      20,
    );
  renderCards(200);
  expect(animate.mock.contexts).toContain(inside);
  expect(animate.mock.contexts).not.toContain(
    host.querySelector("[data-neighbor]"),
  );
  expect(animate.mock.contexts).not.toContain(
    host.querySelector("[data-outside]"),
  );
});

it("长列表按滚动视口揭示，后续分组与裁剪边界同步移动", () => {
  const scrollRef = createRef<HTMLDivElement>();
  const renderList = (open: boolean) =>
    act(() =>
      root.render(
        <div ref={scrollRef} data-reveal-boundary>
          <ContentReveal open={open} transitionKey={null} scrollRef={scrollRef}>
            <div data-size={2000} />
          </ContentReveal>
          <div data-follower />
        </div>,
      ),
    );
  renderList(false);
  const scroll = scrollRef.current;
  const follower = host.querySelector<HTMLElement>("[data-follower]");
  if (!scroll || !follower) throw new Error("缺少滚动视口或后续分组");
  scroll.getBoundingClientRect = () => new DOMRect(0, 0, 200, 300);
  follower.getBoundingClientRect = () =>
    new DOMRect(
      0,
      host.querySelector('[data-state="open"]') ? 2000 : 0,
      200,
      24,
    );
  renderList(true);
  const shell = scroll.firstElementChild as HTMLElement;
  const viewport = shell.firstElementChild as HTMLElement;
  const revealIndex = animate.mock.contexts.indexOf(viewport);
  const followerIndex = animate.mock.contexts.indexOf(follower);
  expect(viewport.style.height).toBe("300px");
  expect(animate.mock.calls[revealIndex][0]).toEqual([
    { offset: 0, translate: "0 -300px" },
    { offset: 1, translate: "0 0px" },
  ]);
  expect(animate.mock.calls[followerIndex][0]).toEqual([
    { translate: "0 -2000px" },
    { translate: "0 -1700px" },
  ]);
  expect(shell.style.height).toBe("2000px");
  finish();
  expect(viewport.style.height).toBe("");
  expect(follower.style.getPropertyValue("translate")).toBe("");
  renderList(false);
  finish();
  renderList(true);
  const pending = animations.filter(
    (animation) => animation.onfinish || animation.oncancel,
  );
  act(() => scroll.dispatchEvent(new Event("scroll")));
  expect(viewport.style.height).toBe("");
  for (const animation of pending)
    expect(animation.cancel).toHaveBeenCalledOnce();
});

// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelParameterReveal } from "@/modules/ai/components/ModelParameterReveal";

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
      <ModelParameterReveal open={open} transitionKey={key}>
        <div key={key} data-size={height}>
          <input defaultValue={key} />
        </div>
      </ModelParameterReveal>,
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
            <ModelParameterReveal open transitionKey={String(size)}>
              <div data-size={size} />
            </ModelParameterReveal>
            <div data-follower />
          </section>
          <div data-outside />
        </>,
      ),
    );
  renderPanel(2000);
  const follower = host.querySelector<HTMLElement>("[data-follower]");
  if (!follower) throw new Error("缺少后续内容");
  vi.spyOn(follower, "getBoundingClientRect").mockImplementation(
    () =>
      new DOMRect(
        0,
        Number(host.querySelector("[data-size]")?.getAttribute("data-size")),
        200,
        20,
      ),
  );
  renderPanel(100);
  expect(animate.mock.contexts).toContain(follower);
  expect(animate.mock.contexts).not.toContain(
    host.querySelector("[data-outside]"),
  );
  finish();
});

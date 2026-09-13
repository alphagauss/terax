// @vitest-environment happy-dom

import { useSectionLayoutAnimation } from "@/modules/sidebar/useSectionLayoutAnimation";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

function setup() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const group = createRef<HTMLDivElement>();
  let capture = () => {};
  let revision = 0;
  function Harness({ version }: { version: number }) {
    const motion = useSectionLayoutAnimation(group);
    capture = motion.capture;
    return (
      <div ref={group} data-version={version} data-animating={motion.animating}>
        <div data-panel>
          <div data-section-viewport>
            <div>Content</div>
          </div>
        </div>
        <div data-slot="resizable-handle" />
      </div>
    );
  }
  const render = () => act(() => root.render(<Harness version={revision++} />));
  render();
  const panel = host.querySelector<HTMLElement>("[data-panel]");
  if (!panel) throw new Error("分组未挂载");
  const viewport = panel.firstElementChild as HTMLElement;
  const content = viewport.firstElementChild as HTMLElement;
  const geometry = {
    top: 0,
    bottom: 300,
    contentHeight: 300,
    targetHeight: 300,
    targetTop: 0,
  };
  vi.spyOn(panel, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, geometry.targetTop, 200, geometry.targetHeight),
  );
  vi.spyOn(content, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, geometry.top, 200, geometry.contentHeight),
  );
  vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 200, geometry.bottom),
  );
  const animations: Animation[] = [];
  const animate = vi.fn(() => {
    const animation = {
      cancel: vi.fn(),
      onfinish: null,
      oncancel: null,
    } as unknown as Animation;
    animations.push(animation);
    return animation;
  });
  viewport.animate = animate;
  content.animate = animate;
  const unmount = () => act(() => root.unmount());
  cleanups.push(() => {
    unmount();
    host.remove();
  });
  return {
    host,
    viewport,
    geometry,
    animations,
    animate,
    render,
    unmount,
    capture: () => capture(),
  };
}

it("continues a reversed transition from its visible position without replacing content", () => {
  const test = setup();
  test.capture();
  test.geometry.targetHeight = 30;
  test.render();
  const previous = [...test.animations];
  expect(test.viewport.style.height).toBe("300px");

  // 模拟反向点击发生时的合成位置，下一次提交必须接住当前可见边界。
  test.geometry.top = 50;
  test.geometry.bottom = 170;
  test.capture();
  test.geometry.targetHeight = 300;
  test.render();
  for (const animation of previous)
    expect(animation.cancel).toHaveBeenCalledOnce();
  expect(test.animate.mock.calls.slice(-2)).toEqual([
    [[{ translate: "0 -130px" }, { translate: "0 0px" }], expect.anything()],
    [[{ translate: "0 180px" }, { translate: "0 0px" }], expect.anything()],
  ]);
  expect(test.host.querySelector("[data-section-viewport]")).toBe(
    test.viewport,
  );
});

it.each(["finish", "cancel", "drag", "unmount"])(
  "releases temporary geometry and animations on %s",
  (reason) => {
    const test = setup();
    test.capture();
    test.geometry.targetHeight = 30;
    test.geometry.targetTop = 270;
    test.render();
    expect(test.viewport.style.getPropertyValue("translate")).toBe("0 -270px");
    if (reason === "finish")
      test.animations[0].onfinish?.call(
        test.animations[0],
        {} as AnimationPlaybackEvent,
      );
    if (reason === "cancel")
      test.animations[0].oncancel?.call(
        test.animations[0],
        {} as AnimationPlaybackEvent,
      );
    if (reason === "drag")
      test.host
        .querySelector('[data-slot="resizable-handle"]')
        ?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    if (reason === "unmount") test.unmount();
    expect(test.viewport.style.height).toBe("");
    expect(test.viewport.style.getPropertyValue("translate")).toBe("");
    for (const animation of test.animations) {
      expect(animation.cancel).toHaveBeenCalledOnce();
      expect(animation.onfinish).toBeNull();
      expect(animation.oncancel).toBeNull();
    }
  },
);

it("退出展示仅保留到动画结束，无动效时同次提交释放", () => {
  const test = setup();
  test.capture();
  test.geometry.targetHeight = 30;
  test.render();
  expect(test.host.querySelector("[data-animating=true]")).not.toBeNull();
  act(() =>
    test.animations[0].onfinish?.call(
      test.animations[0],
      {} as AnimationPlaybackEvent,
    ),
  );
  expect(test.host.querySelector("[data-animating=true]")).toBeNull();
  test.geometry.bottom = 30;
  test.geometry.contentHeight = 30;
  test.capture();
  test.render();
  expect(test.host.querySelector("[data-animating=true]")).toBeNull();
});

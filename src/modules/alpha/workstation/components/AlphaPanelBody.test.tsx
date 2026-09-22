// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AlphaPanelBody } from "@/modules/alpha/workstation/components/AlphaPanelBody";

vi.mock("@/modules/alpha/workstation/components/AlphaPanelPool", () => ({
  AlphaPanelHost: () => <input data-content defaultValue="retained" />,
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let animations: Animation[];
let animate: ReturnType<typeof vi.fn<HTMLElement["animate"]>>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
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
  HTMLElement.prototype.animate = animate;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(0, 0, 300, Number.parseFloat(this.style.height) || 0);
    },
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render(collapsed: boolean, height = 400) {
  act(() =>
    root.render(
      <AlphaPanelBody panelId="chart" collapsed={collapsed} height={height} />,
    ),
  );
}

it("折叠保持内容尺寸和身份，立即禁止命中，结束隐藏并清理动画", () => {
  render(false);
  const input = container.querySelector("input");
  render(true);
  const shell = container.firstElementChild as HTMLElement;
  expect(shell.inert).toBe(true);
  expect(shell.style.height).toBe("400px");
  expect(shell.style.visibility).toBe("");
  expect(container.querySelector("input")).toBe(input);
  expect(animate).toHaveBeenCalledTimes(2);
  for (const [frames] of animate.mock.calls) {
    if (!Array.isArray(frames)) throw new Error("预期逐帧关键帧数组");
    expect(
      frames.every((frame: Record<string, unknown>) =>
        Object.keys(frame).every((key) => key === "translate"),
      ),
    ).toBe(true);
  }
  act(() =>
    animations[0].onfinish?.call(animations[0], {} as AnimationPlaybackEvent),
  );
  expect(shell.style.visibility).toBe("hidden");
  expect(shell.style.height).toBe("0px");
  expect(
    animations.every(
      (animation) => vi.mocked(animation.cancel).mock.calls.length === 1,
    ),
  ).toBe(true);
  render(false);
  expect(shell.inert).toBe(false);
  expect(shell.style.visibility).toBe("");
  expect(container.querySelector("input")).toBe(input);
});

it("快速反向切换沿当前边界继续，取消旧动画且不重建内容", () => {
  render(false);
  render(true);
  const shell = container.firstElementChild as HTMLElement;
  const viewport = shell.firstElementChild as HTMLElement;
  const input = container.querySelector("input");
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(
        0,
        this === viewport ? -150 : 0,
        300,
        Number.parseFloat(this.style.height) || 0,
      );
    },
  );
  const old = [...animations];
  render(false);
  expect(
    old.every(
      (animation) => vi.mocked(animation.cancel).mock.calls.length === 1,
    ),
  ).toBe(true);
  expect(animate.mock.calls[2][0]).toEqual([
    { translate: "0 -150px" },
    { translate: "0 0px" },
  ]);
  expect(container.querySelector("input")).toBe(input);
});

it("减少动态效果时立即到达最终状态", () => {
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
  render(false);
  render(true);
  expect(animate).not.toHaveBeenCalled();
  expect((container.firstElementChild as HTMLElement).style.visibility).toBe(
    "hidden",
  );
  render(false);
  expect((container.firstElementChild as HTMLElement).style.visibility).toBe(
    "",
  );
});

it("普通尺寸更新和已结束的动画不额外读取布局", () => {
  render(false);
  render(false, 500);
  expect(HTMLElement.prototype.getBoundingClientRect).not.toHaveBeenCalled();
  expect(animate).not.toHaveBeenCalled();
  render(true, 500);
  act(() =>
    animations[0].onfinish?.call(animations[0], {} as AnimationPlaybackEvent),
  );
  render(false, 500);
  expect(HTMLElement.prototype.getBoundingClientRect).not.toHaveBeenCalled();
});

it("父页面隐藏时外壳和边框同步隐藏，展开动画结束也不能重新显示", () => {
  render(false);
  const shell = container.firstElementChild as HTMLElement;
  const content = container.querySelector("input");
  container.style.visibility = "hidden";
  container.inert = true;
  expect(getComputedStyle(shell).visibility).toBe("hidden");
  expect(getComputedStyle(content as HTMLElement).visibility).toBe("hidden");

  container.style.visibility = "visible";
  container.inert = false;
  render(true);
  act(() =>
    animations[0].onfinish?.call(animations[0], {} as AnimationPlaybackEvent),
  );
  render(false);
  container.style.visibility = "hidden";
  container.inert = true;
  expect(getComputedStyle(shell).visibility).toBe("hidden");
  const expanding = animations.find((animation) => animation.onfinish);
  act(() => expanding?.onfinish?.call(expanding, {} as AnimationPlaybackEvent));
  expect(getComputedStyle(shell).visibility).toBe("hidden");
  expect(getComputedStyle(content as HTMLElement).visibility).toBe("hidden");

  container.style.visibility = "visible";
  container.inert = false;
  expect(getComputedStyle(shell).visibility).toBe("visible");
  expect(container.querySelector("input")).toBe(content);
});

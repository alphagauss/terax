// @vitest-environment happy-dom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpaceSwitcherMotion } from "./SpaceSwitcherMotion";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let animations: Animation[];
let animate: ReturnType<typeof vi.fn<HTMLElement["animate"]>>;
let intermediateHeight: number | null;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  animations = [];
  intermediateHeight = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
      const open =
        host.querySelector("[data-expanded]")?.getAttribute("data-expanded") ===
        "true";
      let height = this.hasAttribute("data-body") ? 100 : open ? 100 : 0;
      if (this.style.height) height = Number.parseFloat(this.style.height);
      if (this.hasAttribute("data-viewport") && intermediateHeight !== null)
        height = intermediateHeight;
      const top = this.hasAttribute("data-space-motion-row")
        ? open
          ? 100
          : 0
        : 0;
      return new DOMRect(0, top, 320, height);
    },
  );
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

function render(open: boolean, visible = true) {
  const expanded = new Set(open ? ["a"] : []);
  act(() =>
    root.render(
      <SpaceSwitcherMotion expanded={expanded} open={visible} order="unchanged">
        {(present) => (
          <div data-space-scroller>
            <div>
              <div
                data-space-reveal
                data-expanded={open}
                style={open ? undefined : { height: 0, overflow: "hidden" }}
                inert={!open}
              >
                <div data-viewport>
                  <div data-body>
                    {present.has("a") && <input defaultValue="kept" />}
                  </div>
                </div>
              </div>
              <div data-space-motion-row data-space-position="space:b" />
            </div>
          </div>
        )}
      </SpaceSwitcherMotion>,
    ),
  );
}

function finish() {
  const animation = animations.find((item) => item.onfinish);
  act(() => animation?.onfinish?.call(animation, {} as AnimationPlaybackEvent));
}

it("收起立即禁用原展示树，动画结束才移除，后续行同步位移", () => {
  render(true);
  const input = host.querySelector("input");
  render(false);
  expect(host.querySelector("input")).toBe(input);
  expect(input?.closest("[inert]")).not.toBeNull();
  expect(animate.mock.contexts).toContain(
    host.querySelector("[data-space-motion-row]"),
  );
  finish();
  expect(host.querySelector("input")).toBeNull();
  expect(
    host.querySelector<HTMLElement>("[data-space-reveal]")?.style.height,
  ).toBe("0px");
  expect(host.querySelector("[style*='position: absolute']")).toBeNull();
});

it("快速反向切换接住可见边界，保留实例并恢复最终展开高度", () => {
  render(true);
  const input = host.querySelector("input");
  render(false);
  const previous = [...animations];
  // 展开按钮按下后的轻微移动不应提前结束过渡，否则反向点击会从终点跳回。
  host.firstElementChild?.dispatchEvent(
    new PointerEvent("pointermove", { buttons: 1, bubbles: true }),
  );
  for (const animation of previous)
    expect(animation.cancel).not.toHaveBeenCalled();
  intermediateHeight = 45;
  render(true);
  for (const animation of previous)
    expect(animation.cancel).toHaveBeenCalledOnce();
  expect(host.querySelector("input")).toBe(input);
  expect(animate.mock.calls).toContainEqual([
    [{ translate: "0 -55px" }, { translate: "0 0px" }],
    expect.anything(),
  ]);
  finish();
  expect(
    host.querySelector<HTMLElement>("[data-space-reveal]")?.style.height,
  ).toBe("");
});

it.each(["wheel", "close", "unmount"])("%s 清理过渡及临时尺寸", (reason) => {
  render(true);
  render(false);
  if (reason === "wheel")
    act(() =>
      host.firstElementChild?.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true }),
      ),
    );
  if (reason === "close") render(false, false);
  if (reason === "unmount") act(() => root.unmount());
  for (const animation of animations)
    expect(animation.cancel).toHaveBeenCalledOnce();
  expect(host.querySelector("[style*='position: absolute']")).toBeNull();
});

it("减少动态效果时直接移除退出内容且不启动动画", () => {
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: true,
  } as MediaQueryList);
  render(true);
  render(false);
  expect(animate).not.toHaveBeenCalled();
  expect(host.querySelector("input")).toBeNull();
});

it("过渡隔离滚动溢出，结束后恢复阅读位置并释放固定宽度", () => {
  render(true);
  const scroller = host.querySelector<HTMLElement>("[data-space-scroller]");
  if (!scroller) throw new Error("缺少滚动容器");
  scroller.scrollTop = 30;
  render(false);
  expect(scroller.style.overflow).toBe("clip");
  const content = scroller.firstElementChild as HTMLElement;
  expect(content.style.getPropertyValue("translate")).toBe("0 -30px");
  scroller.scrollTop = 0;
  finish();
  expect(scroller.style.overflow).toBe("");
  expect(content.style.width).toBe("");
  expect(content.style.getPropertyValue("translate")).toBe("");
  expect(scroller.scrollTop).toBe(30);
});

function reorderHarness() {
  const control = createRef<SpaceSwitcherMotion>();
  const open = new Set(["a", "b"]);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(
        0,
        Number(this.dataset.top ?? 0),
        320,
        Number(this.dataset.height ?? 300),
      );
    },
  );
  const renderRows = (rows: { id: string; tabs: number[] }[]) =>
    act(() =>
      root.render(
        <SpaceSwitcherMotion
          ref={control}
          expanded={open}
          open
          order={JSON.stringify(rows)}
        >
          {() => (
            <div data-space-scroller>
              <div>
                {rows.map((row, index) => (
                  <div
                    key={row.id}
                    data-space-motion-row
                    data-space-position={`space:${row.id}`}
                    data-top={index * 100}
                    data-height="100"
                  >
                    {row.tabs.map((tab, tabIndex) => (
                      <div
                        key={tab}
                        data-space-position={`tab:${tab}`}
                        data-top={index * 100 + 20 + tabIndex * 25}
                        data-height="25"
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </SpaceSwitcherMotion>,
      ),
    );
  return { control, renderRows };
}

it("Space 整组以 surface 节奏归位，内部工作页不重复叠加位移", () => {
  const { control, renderRows } = reorderHarness();
  const a = { id: "a", tabs: [1, 2] };
  const b = { id: "b", tabs: [3] };
  renderRows([a, b]);
  control.current?.prepareMove("space:b");
  renderRows([b, a]);
  expect(animate).toHaveBeenCalledTimes(2);
  expect(animate.mock.calls[0]).toEqual([
    [{ translate: "0 100px" }, { translate: "0 0px" }],
    expect.objectContaining({ duration: 240 }),
  ]);
  expect(
    host.querySelector<HTMLElement>('[data-space-position="space:b"]')?.style
      .zIndex,
  ).toBe("2");
  finish();
  expect(
    host.querySelector<HTMLElement>('[data-space-position="space:b"]')?.style
      .zIndex,
  ).toBe("");
});

it("组内排序和跨 Space 移动按稳定工作页 ID 衔接，未授权的数据更新不重播", () => {
  const { control, renderRows } = reorderHarness();
  renderRows([
    { id: "a", tabs: [1, 2] },
    { id: "b", tabs: [3] },
  ]);
  control.current?.prepareMove("tab:1");
  renderRows([
    { id: "a", tabs: [2, 1] },
    { id: "b", tabs: [3] },
  ]);
  expect(animate).toHaveBeenCalledTimes(2);
  finish();
  animate.mockClear();
  control.current?.prepareMove("tab:1");
  renderRows([
    { id: "a", tabs: [2] },
    { id: "b", tabs: [3, 1] },
  ]);
  expect(animate.mock.contexts).toContain(
    host.querySelector('[data-space-position="tab:1"]'),
  );
  expect(animate).toHaveBeenCalledWith(
    [{ translate: "0 -100px" }, { translate: "0 0px" }],
    expect.objectContaining({ duration: 240 }),
  );
  finish();
  animate.mockClear();
  control.current?.prepareMove("tab:1");
  renderRows([
    { id: "a", tabs: [2] },
    { id: "b", tabs: [3, 1] },
  ]);
  renderRows([
    { id: "a", tabs: [2, 1] },
    { id: "b", tabs: [3] },
  ]);
  expect(animate).not.toHaveBeenCalled();
});

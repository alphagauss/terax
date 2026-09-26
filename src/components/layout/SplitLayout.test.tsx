// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  ResizeHandle,
  SplitLayout,
  SplitPanel,
} from "@/components/layout/SplitLayout";

it("拖动只更新预览，松手提交一次，取消不会修改图表尺寸", async () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  const commit = vi.fn();
  await act(async () =>
    root.render(
      <ResizeHandle
        label="resize"
        size={240}
        defaultSize={240}
        panelId="panel"
        onCommit={commit}
      />,
    ),
  );
  const divider = element.querySelector<HTMLElement>("[role=separator]");
  if (!divider) throw new Error("missing divider");
  divider.setPointerCapture = vi.fn();
  divider.hasPointerCapture = () => true;
  divider.releasePointerCapture = vi.fn();
  const dispatch = (type: string, x: number, pointerId = 1) =>
    act(() => {
      divider.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId,
          clientX: x,
          button: 0,
        }),
      );
    });
  dispatch("pointerdown", 100);
  dispatch("pointermove", 150);
  expect(commit).not.toHaveBeenCalled();
  expect(divider.firstElementChild?.getAttribute("style")).toContain(
    "translateX(50px)",
  );
  dispatch("pointerdown", 300, 2);
  dispatch("pointermove", 400, 2);
  dispatch("pointerup", 400, 2);
  expect(commit).not.toHaveBeenCalled();
  dispatch("pointerup", 150);
  expect(commit).toHaveBeenCalledExactlyOnceWith(290);
  dispatch("pointerdown", 100);
  dispatch("pointermove", 200);
  dispatch("pointercancel", 200);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(divider.firstElementChild?.getAttribute("style")).toContain("hidden");
  act(() => root.unmount());
});

it("嵌套纵向分割遵循自身方向，约束尺寸，支持复位与取消，收起不卸载内容", async () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  const commit = vi.fn();
  const render = (open: boolean) => (
    <SplitLayout>
      <SplitPanel id="outer">
        <SplitLayout direction="vertical">
          <SplitPanel id="inner" size={240} open={open}>
            <input defaultValue="draft" />
          </SplitPanel>
          <ResizeHandle
            label="vertical"
            panelId="inner"
            size={240}
            defaultSize={240}
            minSize={100}
            maxSize={300}
            onCommit={commit}
          />
          <SplitPanel id="rest">rest</SplitPanel>
        </SplitLayout>
      </SplitPanel>
    </SplitLayout>
  );
  await act(async () => root.render(render(true)));
  const input = element.querySelector("input");
  const divider = element.querySelector<HTMLElement>("[role=separator]");
  if (!divider) throw new Error("missing divider");
  expect(divider.getAttribute("aria-orientation")).toBe("horizontal");
  expect(element.querySelector<HTMLElement>("#inner")?.style.height).toBe(
    "240px",
  );
  divider.setPointerCapture = vi.fn();
  divider.hasPointerCapture = () => true;
  divider.releasePointerCapture = vi.fn();
  const pointer = (type: string, y: number) =>
    act(() =>
      divider.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          clientY: y,
          button: 0,
        }),
      ),
    );
  pointer("pointerdown", 0);
  pointer("pointermove", 150);
  expect(commit).not.toHaveBeenCalled();
  expect(divider.firstElementChild?.getAttribute("style")).toContain(
    "translateY(60px)",
  );
  pointer("pointerup", 150);
  expect(commit).toHaveBeenLastCalledWith(300);
  const key = (key: string) =>
    act(() =>
      divider.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key }),
      ),
    );
  key("ArrowDown");
  expect(commit).toHaveBeenLastCalledWith(256);
  key("Home");
  expect(commit).toHaveBeenLastCalledWith(100);
  act(() =>
    divider.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  expect(commit).toHaveBeenLastCalledWith(240);
  commit.mockClear();
  pointer("pointerdown", 0);
  pointer("pointermove", 50);
  key("Escape");
  pointer("pointerup", 50);
  expect(commit).not.toHaveBeenCalled();
  await act(async () => root.render(render(false)));
  expect(element.querySelector("input")).toBe(input);
  expect(element.querySelector<HTMLElement>("#inner")?.hidden).toBe(true);
  await act(async () => root.render(render(true)));
  expect(element.querySelector("input")).toBe(input);
  act(() => root.unmount());
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AlphaDeskDivider } from "@/modules/alpha/desk/AlphaDeskDivider";

it("拖动只更新预览，松手提交一次，取消不会修改图表尺寸", async () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  const commit = vi.fn();
  await act(async () =>
    root.render(
      <AlphaDeskDivider label="resize" width={240} onCommit={commit} />,
    ),
  );
  const divider = element.querySelector<HTMLElement>("[role=separator]");
  if (!divider) throw new Error("missing divider");
  divider.setPointerCapture = vi.fn();
  divider.hasPointerCapture = () => true;
  divider.releasePointerCapture = vi.fn();
  const dispatch = (type: string, x: number) =>
    act(() => {
      divider.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
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
  dispatch("pointerup", 150);
  expect(commit).toHaveBeenCalledExactlyOnceWith(290);
  dispatch("pointerdown", 100);
  dispatch("pointermove", 200);
  dispatch("pointercancel", 200);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(divider.firstElementChild?.getAttribute("style")).toContain("hidden");
  act(() => root.unmount());
});

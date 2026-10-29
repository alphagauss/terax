// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useExplorerDnd } from "@/modules/explorer/lib/useExplorerDnd";
import { registerResourceDropTarget } from "@/modules/file-actions/resourceDrop";

it("拖入附件目标只附加；取消或拖出文件树不会移动，拖回根目录仍可移动", () => {
  const env = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  };
  env.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const onMove = vi.fn();
  const drop = vi.fn();
  const composer = document.createElement("div");
  const unregister = registerResourceDropTarget({
    element: composer,
    hover: vi.fn(),
    drop,
  });
  const point = vi.spyOn(document, "elementFromPoint");
  function Harness() {
    const dnd = useExplorerDnd({
      rootPath: "/root",
      isDir: (path) => path !== "/root/sub/a.ts",
      onMove,
    });
    return (
      <div data-explorer-drop onPointerDown={dnd.onPointerDown}>
        <div data-fs-path="/root/sub/a.ts">a.ts</div>
      </div>
    );
  }
  const drag = (target: Element | null, cancel = false, release = target) => {
    point.mockReturnValue(target);
    act(() =>
      container.querySelector("[data-fs-path]")?.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 10,
          clientY: 10,
        }),
      ),
    );
    act(() =>
      window.dispatchEvent(
        new PointerEvent("pointermove", { clientX: 30, clientY: 30 }),
      ),
    );
    point.mockReturnValue(release);
    act(() =>
      window.dispatchEvent(
        new PointerEvent(cancel ? "pointercancel" : "pointerup", {
          clientX: 40,
          clientY: 40,
        }),
      ),
    );
  };
  try {
    act(() => root.render(<Harness />));
    drag(composer);
    expect(drop).toHaveBeenCalledExactlyOnceWith("/root/sub/a.ts");
    expect(onMove).not.toHaveBeenCalled();
    drag(composer, true);
    drag(document.createElement("div"));
    drag(composer, false, document.createElement("div"));
    drag(container.firstElementChild, false, document.createElement("div"));
    expect(drop).toHaveBeenCalledTimes(1);
    expect(onMove).not.toHaveBeenCalled();
    drag(container.firstElementChild);
    expect(onMove).toHaveBeenCalledExactlyOnceWith("/root/sub/a.ts", "/root");
  } finally {
    act(() => root.unmount());
    unregister();
    vi.restoreAllMocks();
    env.IS_REACT_ACT_ENVIRONMENT = false;
  }
});

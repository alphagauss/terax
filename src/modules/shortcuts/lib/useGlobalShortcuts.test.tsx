// @vitest-environment happy-dom
import { MOD_PROP } from "@/lib/platform";
import { useGlobalShortcuts } from "@/modules/shortcuts/lib/useGlobalShortcuts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (selector: (state: { shortcuts: object }) => unknown) =>
    selector({ shortcuts: {} }),
}));

it("浮层内保留原生编辑操作并允许宿主导航，普通页面仍处理原快捷键", async () => {
  const undo = vi.fn();
  const newTab = vi.fn();
  function Harness() {
    useGlobalShortcuts({ "editor.undo": undo, "tab.new": newTab });
    return (
      <>
        <div data-workbench-page-overlay="dialog">
          <input />
        </div>
        <input data-page="" />
      </>
    );
  }
  const environment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    const inputs = container.querySelectorAll("input");
    const send = (input: HTMLInputElement, key: string) => {
      const event = new KeyboardEvent("keydown", {
        key,
        code: `Key${key.toUpperCase()}`,
        [MOD_PROP === "meta" ? "metaKey" : "ctrlKey"]: true,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);
      return event;
    };
    expect(send(inputs[0], "z").defaultPrevented).toBe(false);
    expect(undo).not.toHaveBeenCalled();
    expect(send(inputs[0], "t").defaultPrevented).toBe(true);
    expect(newTab).toHaveBeenCalledTimes(1);
    send(inputs[1], "z");
    expect(undo).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  }
});

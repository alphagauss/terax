// @vitest-environment happy-dom

import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ theme: [] }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("./lib/useEditorThemeExt", () => ({
  useEditorThemeExt: () => mocks.theme,
}));
vi.mock("./lib/languageResolver", () => ({
  resolveLanguageSync: () => ({ ext: [] }),
}));
vi.mock("./lib/find/editorFindPanel", () => ({
  openEditorFindPanel: vi.fn(),
}));
vi.mock("./lib/extensions", async () => {
  const { Compartment, EditorState } = await import("@codemirror/state");
  const wrapCompartment = new Compartment();
  return {
    buildSharedExtensions: () => [],
    DEFAULT_INDENT: [],
    FOCUSABLE_READONLY_EXTENSIONS: [EditorState.readOnly.of(true)],
    languageCompartment: new Compartment(),
    wrapCompartment,
    reconfigureWordWrap: (view: EditorView, wrap: boolean) =>
      view.dispatch({
        effects: wrapCompartment.reconfigure(
          wrap ? EditorView.lineWrapping : [],
        ),
      }),
  };
});

import { SplitDiffView } from "./SplitDiffView";

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("分栏提交保留编辑器和内容，滚动条随比例对齐，容器变化保留比例，重新打开恢复等宽", async () => {
  let width = 1000;
  const observers: { target?: Element; notify: () => void }[] = [];
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("cm-mergeViewEditors") ? width : 0;
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observer: (typeof observers)[number];
      constructor(callback: () => void) {
        this.observer = { notify: callback };
        observers.push(this.observer);
      }
      observe(target: Element) {
        this.observer.target = target;
      }
      disconnect() {}
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (modified = "after") =>
    act(() =>
      root?.render(
        <SplitDiffView
          original="before"
          modified={modified}
          path="file.txt"
          wordWrap={false}
        />,
      ),
    );
  await render();
  const shell = container.querySelector<HTMLElement>(".split-diff-view");
  const divider = container.querySelector<HTMLElement>("[role=separator]");
  const merge = container.querySelector(".cm-mergeView");
  const editors = [...container.querySelectorAll<HTMLElement>(".cm-editor")];
  const scrollbars = container.querySelector<HTMLElement>(
    ".split-diff-scrollbars",
  );
  if (!shell || !divider || !scrollbars) throw new Error("missing split view");
  divider.setPointerCapture = vi.fn();
  divider.hasPointerCapture = () => true;
  divider.releasePointerCapture = vi.fn();
  const pointer = (type: string, x: number) =>
    act(() =>
      divider.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          clientX: x,
          button: 0,
        }),
      ),
    );
  const ratio = () => shell.style.getPropertyValue("--split-diff-left-width");
  expect(ratio()).toBe("50%");
  pointer("pointerdown", 500);
  pointer("pointermove", 700);
  expect(ratio()).toBe("50%");
  pointer("pointerup", 700);
  expect(ratio()).toBe("70%");
  expect(divider.parentElement?.style.left).toBe("700px");
  expect(scrollbars.style.width).toBe("1000px");
  expect(container.querySelector(".cm-mergeView")).toBe(merge);
  expect([...container.querySelectorAll(".cm-editor")]).toEqual(editors);
  expect(EditorView.findFromDOM(editors[0])?.state.doc.toString()).toBe(
    "before",
  );
  await render("updated");
  expect(EditorView.findFromDOM(editors[1])?.state.doc.toString()).toBe(
    "updated",
  );
  expect(ratio()).toBe("70%");

  // 隐藏和缩小仅重新计算实际宽度，不覆盖当前视图内的临时比例。
  const observer = observers.find((item) =>
    item.target?.classList.contains("cm-mergeViewEditors"),
  );
  if (!observer) throw new Error("missing width observer");
  width = 0;
  act(() => observer.notify());
  width = 600;
  act(() => observer.notify());
  const resizedDivider =
    container.querySelector<HTMLElement>("[role=separator]");
  expect(resizedDivider?.parentElement?.style.left).toBe("420px");
  expect(scrollbars.style.width).toBe("600px");
  expect(ratio()).toBe("70%");
  expect(container.querySelector(".cm-mergeView")).toBe(merge);
  act(() =>
    resizedDivider?.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true }),
    ),
  );
  expect(ratio()).toBe("50%");

  act(() =>
    resizedDivider?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }),
    ),
  );
  expect(ratio()).not.toBe("50%");
  act(() => root?.render(null));
  await render();
  expect(
    container
      .querySelector<HTMLElement>(".split-diff-view")
      ?.style.getPropertyValue("--split-diff-left-width"),
  ).toBe("50%");
});

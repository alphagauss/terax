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

it("横向同步不把延迟回声写回新的输入，尺寸未变时不覆盖拖动位置", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const observers: { targets: Element[]; notify: () => void }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observer: (typeof observers)[number];
      constructor(callback: () => void) {
        this.observer = { targets: [], notify: callback };
        observers.push(this.observer);
      }
      observe(target: Element) {
        this.observer.targets.push(target);
      }
      disconnect() {}
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    root?.render(
      <SplitDiffView
        original="before"
        modified="after"
        path="file.txt"
        wordWrap={false}
      />,
    ),
  );
  const editor = container.querySelector<HTMLElement>(".cm-scroller");
  const scrollbar = container.querySelector<HTMLElement>(
    ".split-diff-horizontal-scrollbar",
  );
  const observer = observers.find((item) =>
    item.targets.some((target) => target.classList.contains("cm-content")),
  );
  if (!editor || !scrollbar || !observer) throw new Error("missing scrollbar");
  let scrollWidth = 1000;
  let editorLeft = 0;
  let scrollbarLeft = 0;
  Object.defineProperties(editor, {
    scrollWidth: { get: () => scrollWidth },
    clientWidth: { get: () => 100 },
    scrollLeft: {
      get: () => Math.min(editorLeft, scrollWidth - 100),
      set: (value: number) => {
        editorLeft = Math.min(value, scrollWidth - 100);
      },
    },
  });
  Object.defineProperty(scrollbar, "scrollLeft", {
    get: () => Math.min(scrollbarLeft, scrollWidth - 100),
    set: (value: number) => {
      scrollbarLeft = Math.min(value, scrollWidth - 100);
    },
  });
  observer.notify();
  const scroll = (element: HTMLElement) =>
    element.dispatchEvent(new Event("scroll"));

  // 编辑器继续向前滚动时，前一次同步产生的滚动条事件不能拉回内容。
  editorLeft = 100;
  scroll(editor);
  expect(scrollbar.scrollLeft).toBe(100);
  editorLeft = 140;
  scroll(scrollbar);
  expect(editor.scrollLeft).toBe(140);
  scroll(editor);
  expect(scrollbar.scrollLeft).toBe(140);
  scroll(scrollbar);

  // 拖动继续向前时，编辑器的同步回声也不能拉回正在移动的滑块。
  scrollbarLeft = 200;
  scroll(scrollbar);
  expect(editor.scrollLeft).toBe(200);
  scrollbarLeft = 260;
  scroll(editor);
  expect(scrollbar.scrollLeft).toBe(260);
  scroll(scrollbar);
  expect(editor.scrollLeft).toBe(260);
  scroll(editor);

  scrollbarLeft = 320;
  observer.notify();
  expect(scrollbar.scrollLeft).toBe(320);
  scroll(scrollbar);
  scroll(editor);
  scrollWidth = 350;
  observer.notify();
  expect(editor.scrollLeft).toBe(250);
  expect(scrollbar.scrollLeft).toBe(250);
  expect(scrollbar.firstElementChild?.getAttribute("style")).toContain(
    "width: 350px",
  );
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

// @vitest-environment happy-dom

import {
  getOriginalDoc,
  originalDocChangeEffect,
  unifiedMergeView,
} from "@codemirror/merge";
import { ChangeSet, Compartment } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { unifiedDiffLineNumbers } from "./unifiedDiffLineNumbers";

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
const numbers = () =>
  [...document.querySelectorAll(".cm-deletedLineNumber")].map(
    (line) => line.textContent,
  );
function editor(original: string, modified: string) {
  const parent = document.body.appendChild(document.createElement("div"));
  const wrap = new Compartment();
  view = new EditorView({
    parent,
    doc: modified,
    extensions: [
      lineNumbers(),
      unifiedMergeView({ original, mergeControls: false, gutter: false }),
      unifiedDiffLineNumbers,
      wrap.of([]),
    ],
  });
  return { view, wrap };
}

it("大段替换为旧文件每个删除行编号，并保留新文件正文和原始快照", () => {
  const original = `${Array.from({ length: 104 }, (_, i) => `old line ${i + 1}`).join("\n")}\n`;
  const modified = `${Array.from({ length: 16 }, (_, i) => `new line ${i + 1}`).join("\n")}\n`;
  const { view } = editor(original, modified);
  expect(numbers()).toEqual(
    Array.from({ length: 104 }, (_, i) => String(i + 1)),
  );
  expect(view.state.doc.toString()).toBe(modified);
  expect(getOriginalDoc(view.state).toString()).toBe(original);
  const currentNumbers = [
    ...view.dom.querySelectorAll<HTMLElement>(
      ".cm-lineNumbers > .cm-gutterElement",
    ),
  ]
    .filter(
      (line) =>
        line.style.visibility !== "hidden" &&
        !line.classList.contains("cm-deletedLineNumbersGutter"),
    )
    .map((line) => line.textContent);
  expect(currentNumbers).toEqual(
    Array.from({ length: 17 }, (_, i) => String(i + 1)),
  );
});

it("混合新增、多个删除块与空行按旧文件位置编号，基线刷新后更新偏移", () => {
  const lead = Array.from({ length: 10 }, (_, i) => `unchanged lead ${i}`);
  const middle = Array.from({ length: 10 }, (_, i) => `unchanged middle ${i}`);
  const tail = Array.from({ length: 10 }, (_, i) => `unchanged tail ${i}`);
  const original = [
    ...lead,
    "old one",
    "",
    "old three",
    ...middle,
    "removed end",
    ...tail,
  ].join("\n");
  const modified = [
    "inserted first",
    ...lead,
    "replacement",
    ...middle,
    ...tail,
  ].join("\n");
  const { view } = editor(original, modified);
  expect(numbers()).toEqual(["11", "12", "13", "24"]);
  const old = getOriginalDoc(view.state);
  view.dispatch({
    changes: { from: 0, insert: "prefix\n" },
    effects: originalDocChangeEffect(
      view.state,
      ChangeSet.of({ from: 0, insert: "prefix\n" }, old.length),
    ),
  });
  expect(numbers()).toEqual(["12", "13", "14", "25"]);
});

it("删除行换行后同步行号高度，部件回收时释放尺寸观测", () => {
  const observers: {
    target?: Element;
    notify: () => void;
    disconnect: () => void;
  }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      record: (typeof observers)[number];
      constructor(callback: () => void) {
        this.record = { notify: callback, disconnect: vi.fn() };
        observers.push(this.record);
      }
      observe(target: Element) {
        this.record.target = target;
      }
      unobserve() {}
      disconnect() {
        this.record.disconnect();
      }
    },
  );
  const requests = vi.spyOn(EditorView.prototype, "requestMeasure");
  const { view: current, wrap } = editor("old first\n\nold last", "new");
  const chunk = current.dom.querySelector<HTMLElement>(".cm-deletedChunk");
  const marker = current.dom.querySelector<HTMLElement>(
    ".cm-deletedLineNumbers",
  );
  if (!chunk || !marker) throw new Error("缺少删除行或行号");
  chunk.style.paddingTop = "3px";
  chunk.style.paddingBottom = "2px";
  const lines = [...chunk.querySelectorAll<HTMLElement>(".cm-deletedLine")];
  let heights = [40, 20, 60];
  lines.forEach((line, index) => {
    vi.spyOn(line, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 0, 100, heights[index]),
    );
  });
  const observer = observers.find((item) => item.target === chunk);
  if (!observer) throw new Error("缺少删除块尺寸观测");
  const measure = () => {
    observer.notify();
    const request = requests.mock.calls
      .slice()
      .reverse()
      .find(([request]) => request?.key === marker)?.[0];
    if (!request) throw new Error("缺少行号测量");
    request.write?.(request.read(current), current);
  };
  measure();
  expect(
    [...marker.children].map((line) => (line as HTMLElement).style.height),
  ).toEqual(["40px", "20px", "60px"]);
  expect(marker.style.paddingTop).toBe("3px");
  expect(marker.style.paddingBottom).toBe("2px");
  current.dispatch({ effects: wrap.reconfigure(EditorView.lineWrapping) });
  heights = [20, 20, 20];
  measure();
  expect(
    [...marker.children].map((line) => (line as HTMLElement).style.height),
  ).toEqual(["20px", "20px", "20px"]);
  expect(numbers()).toEqual(["1", "2", "3"]);
  current.destroy();
  expect(observer.disconnect).toHaveBeenCalledOnce();
  view = undefined;
});

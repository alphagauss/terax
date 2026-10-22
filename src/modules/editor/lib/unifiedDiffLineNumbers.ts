/**
 * 为统一 Diff 的删除部件补充旧文件行号，正文继续使用新文件行号。
 * 沿用 MergeView 的删除内容与高亮，通过公共行号接口同步部件尺寸。
 */

import { getChunks, getOriginalDoc } from "@codemirror/merge";
import {
  EditorView,
  GutterMarker,
  lineNumberWidgetMarker,
} from "@codemirror/view";

// gutter 可能用相等的新 marker 替换旧实例，观测清理须按真实 DOM 归属。
const observers = new WeakMap<Node, ResizeObserver>();

class DeletedLineNumbers extends GutterMarker {
  elementClass = "cm-deletedLineNumbersGutter";

  constructor(
    readonly chunkDOM: HTMLElement,
    readonly firstLine: number,
  ) {
    super();
  }

  eq(other: DeletedLineNumbers) {
    return (
      this.chunkDOM === other.chunkDOM && this.firstLine === other.firstLine
    );
  }

  toDOM(view: EditorView) {
    const dom = document.createElement("div");
    dom.className = "cm-deletedLineNumbers";
    dom.setAttribute("aria-hidden", "true");
    const lines = [
      ...this.chunkDOM.querySelectorAll<HTMLElement>(".cm-deletedLine"),
    ];
    const numbers = lines.map((_, index) => {
      const number = dom.appendChild(document.createElement("div"));
      number.className = "cm-deletedLineNumber";
      number.textContent = String(this.firstLine + index);
      return number;
    });
    const measure = () =>
      view.requestMeasure({
        key: dom,
        read: () => {
          if (!dom.isConnected || !this.chunkDOM.isConnected) return null;
          const style = getComputedStyle(this.chunkDOM);
          return {
            paddingTop: style.paddingTop,
            paddingBottom: style.paddingBottom,
            heights: lines.map((line) => line.getBoundingClientRect().height),
          };
        },
        write: (layout) => {
          if (!layout || !dom.isConnected) return;
          dom.style.paddingTop = layout.paddingTop;
          dom.style.paddingBottom = layout.paddingBottom;
          layout.heights.forEach((height, index) => {
            if (height > 0) numbers[index].style.height = `${height}px`;
          });
        },
      });
    // 观察删除内容而非 gutter，自适应换行与字体变化且不形成尺寸反馈循环。
    const observer = new ResizeObserver(measure);
    observer.observe(this.chunkDOM);
    observers.set(dom, observer);
    measure();
    return dom;
  }

  destroy(dom: Node) {
    observers.get(dom)?.disconnect();
    observers.delete(dom);
  }
}

/** Git 与 AI 的统一 Diff 共用；只为带原始内容的删除部件生成行号。 */
export const unifiedDiffLineNumbers = [
  lineNumberWidgetMarker.of((view, widget, block) => {
    const chunk = getChunks(view.state)?.chunks.find(
      (chunk) => chunk.fromB === block.from && chunk.fromA < chunk.toA,
    );
    if (!chunk) return null;
    const dom = widget.toDOM(view);
    if (
      !dom.classList.contains("cm-deletedChunk") ||
      !dom.querySelector(".cm-deletedLine")
    )
      return null;
    return new DeletedLineNumbers(
      dom,
      getOriginalDoc(view.state).lineAt(chunk.fromA).number,
    );
  }),
  EditorView.baseTheme({
    ".cm-deletedLineNumbers": { whiteSpace: "nowrap" },
  }),
];

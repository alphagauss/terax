/**
 * 本文件定义所有 CodeMirror 视图共享的扩展和可动态重配的编辑器外观。
 *
 * 字号与应用缩放必须通过 CodeMirror 事务更新，避免外部 CSS 变化绕过其虚拟化测量缓存。
 */

import { detectMonoFontFamily } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { indentUnit } from "@codemirror/language";
import { lintGutter } from "@codemirror/lint";
import { search } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { chromeTheme } from "./chromeTheme";
import { createEditorFindPanel } from "./find/editorFindPanel";
import { indentGuides } from "./indentGuides";

// Compartments allow runtime reconfiguration without rebuilding state.
export const languageCompartment = new Compartment();
export const READONLY_EXTENSIONS: Extension[] = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
];
export const readOnlyCompartment = new Compartment();
export const wrapCompartment = new Compartment();
export const vimCompartment = new Compartment();
export const lspCompartment = new Compartment();
export const indentCompartment = new Compartment();
const editorFontMetricsCompartment = new Compartment();

const editorFontSizeExtensions = new Map<number, Extension>();

/** 计算 CodeMirror 在抵消应用 CSS zoom 后应使用的字号。 */
export function effectiveEditorFontSize(
  editorFontSize: number,
  zoomLevel: number,
): number {
  return editorFontSize * zoomLevel;
}

function editorFontSizeExtension(fontSize: number): Extension {
  const cached = editorFontSizeExtensions.get(fontSize);
  if (cached) return cached;
  const extension = EditorView.theme({
    ".cm-scroller": {
      fontSize: `${fontSize}px`,
    },
  });
  editorFontSizeExtensions.set(fontSize, extension);
  return extension;
}

/**
 * 通过 CodeMirror 配置事务更新字号并请求重新测量。
 *
 * 字号主题变化会由 CodeMirror 自己维护滚动锚点。这里不能预读布局或主动滚动，
 * 因为视图首次挂载时可能仍位于隐藏容器，错误的零尺寸测量会污染虚拟视口。
 */
export function reconfigureEditorFontMetrics(
  view: EditorView,
  editorFontSize: number,
  zoomLevel: number,
): void {
  reconfigureEditorFontSize(
    view,
    effectiveEditorFontSize(editorFontSize, zoomLevel),
  );
}

/** 仅重配已经合成应用缩放的字号，避免同步器重复读取偏好。 */
function reconfigureEditorFontSize(view: EditorView, fontSize: number): void {
  view.dispatch({
    effects: editorFontMetricsCompartment.reconfigure(
      editorFontSizeExtension(fontSize),
    ),
  });
  view.requestMeasure();
}

/**
 * 创建与初始字号绑定的偏好同步扩展。
 *
 * 初始值用于消除视图创建后的无效重配，同时仍能覆盖扩展构建与插件挂载之间发生的偏好水合。
 */
function editorFontMetricsSync(initialFontSize: number): Extension {
  return ViewPlugin.fromClass(
    class EditorFontMetricsSync {
      private frame: number | null = null;
      private pendingFontSize = initialFontSize;
      private appliedFontSize = initialFontSize;
      private readonly ownerWindow: Window;
      private readonly unsubscribe: () => void;

      constructor(private readonly view: EditorView) {
        this.ownerWindow = view.dom.ownerDocument.defaultView ?? window;
        const current = usePreferencesStore.getState();
        this.pendingFontSize = effectiveEditorFontSize(
          current.editorFontSize,
          current.zoomLevel,
        );
        this.unsubscribe = usePreferencesStore.subscribe((state) => {
          const nextFontSize = effectiveEditorFontSize(
            state.editorFontSize,
            state.zoomLevel,
          );
          this.pendingFontSize = nextFontSize;
          if (nextFontSize === this.appliedFontSize) return;
          this.schedule();
        });
        if (this.pendingFontSize !== this.appliedFontSize) {
          this.schedule();
        }
      }

      private schedule(): void {
        if (this.frame !== null) return;
        this.frame = this.ownerWindow.requestAnimationFrame(() => {
          this.frame = null;
          const nextFontSize = this.pendingFontSize;
          if (nextFontSize === this.appliedFontSize) return;
          reconfigureEditorFontSize(this.view, nextFontSize);
          this.appliedFontSize = nextFontSize;
        });
      }

      destroy(): void {
        if (this.frame !== null) {
          this.ownerWindow.cancelAnimationFrame(this.frame);
        }
        this.unsubscribe();
      }
    },
  );
}

export function indentExtension(unit: string): Extension {
  return [
    indentUnit.of(unit),
    EditorState.tabSize.of(unit === "\t" ? 4 : unit.length),
    indentGuides(),
  ];
}

export const DEFAULT_INDENT: Extension = indentExtension("  ");

// Only what basicSetup doesn't already cover, to avoid duplicate extensions.
// basicSetup gives us line numbers, fold gutter, history, indentOnInput,
// bracketMatching, closeBrackets, autocompletion, highlightActiveLine,
// highlightSelectionMatches and the search keymap.
// Singleton: per-pane instances would inject duplicate style modules.
const SHARED_EXTENSIONS: readonly Extension[] = Object.freeze([
  search({ top: true, createPanel: createEditorFindPanel }),
  lintGutter(),
  chromeTheme(),
  EditorView.theme({
    "&, &.cm-editor, &.cm-editor.cm-focused": {
      backgroundColor: "transparent !important",
      color: "var(--foreground)",
      outline: "none",
      padding: "0px",
    },
    ".cm-scroller": {
      fontFamily: detectMonoFontFamily(),
      lineHeight: "1.55",
      backgroundColor: "transparent !important",
    },
    ".cm-content": {
      caretColor: "var(--foreground)",
      backgroundColor: "transparent !important",
    },
    ".cm-gutters": {
      backgroundColor: "var(--background) !important",
      color: "var(--muted-foreground)",
    },
    ".cm-gutter-lint": {
      width: "0px",
    },
    ".cm-gutter": { backgroundColor: "transparent !important" },
    ".cm-lineNumbers .cm-gutterElement": {
      opacity: "1",
    },
    ".cm-foldGutter": { width: "10px" },
    ".cm-foldGutter .cm-gutterElement": {
      color: "var(--muted-foreground)",
      opacity: "1",
    },
    ".cm-activeLine": {
      borderTopRightRadius: "5px",
      borderBottomRightRadius: "5px",
      backgroundColor: "transparent !important",
      boxShadow:
        "inset 0 1px color-mix(in srgb, var(--foreground) 10%, transparent), inset 0 -1px color-mix(in srgb, var(--foreground) 10%, transparent)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent !important",
      boxShadow:
        "inset 0 1px color-mix(in srgb, var(--foreground) 10%, transparent), inset 0 -1px color-mix(in srgb, var(--foreground) 10%, transparent)",
    },
    ".cm-lineNumbers .cm-activeLineGutter": {
      borderTopLeftRadius: "5px",
      borderBottomLeftRadius: "5px",
      color: "var(--foreground) !important",
      opacity: "1",
      userSelect: "none",
    },
    ".dark & .cm-lineNumbers .cm-activeLineGutter": {
      color: "#ffffff !important",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--foreground)",
    },
    // Vim normal-mode block cursor — translucent foreground, no rose hue.
    ".cm-fat-cursor": {
      background:
        "color-mix(in srgb, var(--foreground) 35%, transparent) !important",
      outline:
        "1px solid color-mix(in srgb, var(--foreground) 55%, transparent) !important",
      color: "var(--foreground) !important",
      borderRadius: "2px",
    },
    "&:not(.cm-focused) .cm-fat-cursor": {
      background: "transparent !important",
      outline:
        "1px solid color-mix(in srgb, var(--foreground) 35%, transparent) !important",
    },
    ".cm-panels": {
      backgroundColor: "transparent",
      border: "none",
    },
    ".cm-panel.terax-find-panel-host": {
      position: "absolute",
      zIndex: "30",
      top: "0",
      right: "0",
      left: "0",
      display: "flex",
      justifyContent: "flex-end",
      padding: "3px 24px 0 8px",
      backgroundColor: "transparent",
      border: "none",
      pointerEvents: "none",
    },
    ".cm-panel.terax-find-panel-host .terax-find-widget": {
      pointerEvents: "auto",
    },
  }),
]);

export function buildSharedExtensions(): readonly Extension[] {
  const { editorFontSize, zoomLevel } = usePreferencesStore.getState();
  const initialFontSize = effectiveEditorFontSize(editorFontSize, zoomLevel);
  return [
    ...SHARED_EXTENSIONS,
    editorFontMetricsCompartment.of(editorFontSizeExtension(initialFontSize)),
    editorFontMetricsSync(initialFontSize),
  ];
}

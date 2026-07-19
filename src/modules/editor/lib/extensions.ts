import { detectMonoFontFamily } from "@/lib/fonts";
import { indentUnit } from "@codemirror/language";
import { lintGutter } from "@codemirror/lint";
import { search } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
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
      fontSize: "calc(var(--editor-font-size, 13px) * var(--app-zoom, 1))",
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
  return SHARED_EXTENSIONS;
}

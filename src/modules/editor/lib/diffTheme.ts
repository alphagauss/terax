import { EditorView } from "@codemirror/view";

const ADDED = "var(--terminal-ansi-green)";
const REMOVED = "var(--terminal-ansi-red)";

const ADDED_TEXT = `color-mix(in srgb, ${ADDED} 20%, transparent) !important`;
const REMOVED_TEXT = `color-mix(in srgb, ${REMOVED} 22%, transparent) !important`;
const ADDED_LINE = `color-mix(in srgb, ${ADDED} 5%, transparent) !important`;
const REMOVED_LINE = `color-mix(in srgb, ${REMOVED} 5%, transparent) !important`;
const ADDED_GUTTER = `color-mix(in srgb, ${ADDED} 55%, transparent) !important`;
const REMOVED_GUTTER = `color-mix(in srgb, ${REMOVED} 50%, transparent) !important`;

const CHANGED_TEXT_SHAPE = {
  borderRadius: "3px",
  padding: "0 1px",
};

const SHARED_RULES = {
  ".cm-changeGutter": {
    width: "2px !important",
    paddingLeft: "0 !important",
  },
};

const UNIFIED_CHANGE_RULES = {
  "&.cm-merge-b .cm-changedText, .cm-changedText": {
    background: ADDED_TEXT,
    ...CHANGED_TEXT_SHAPE,
  },
  ".cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedText": {
    background: REMOVED_TEXT,
    ...CHANGED_TEXT_SHAPE,
  },
  "&.cm-merge-b .cm-changedLine, .cm-changedLine, .cm-inlineChangedLine": {
    backgroundColor: ADDED_LINE,
  },
  ".cm-deletedChunk": {
    backgroundColor: REMOVED_LINE,
    paddingTop: "1px",
    paddingBottom: "1px",
  },
  "&.cm-merge-b .cm-changedLineGutter, .cm-changedLineGutter": {
    background: ADDED_GUTTER,
  },
  ".cm-deletedLineGutter, &.cm-merge-a .cm-changedLineGutter": {
    background: REMOVED_GUTTER,
  },
  ...SHARED_RULES,
};

const SPLIT_CHANGE_RULES = {
  "&.cm-merge-a .cm-changedText": {
    background: REMOVED_TEXT,
    ...CHANGED_TEXT_SHAPE,
  },
  "&.cm-merge-a .cm-changedLine": {
    backgroundColor: REMOVED_LINE,
  },
  "&.cm-merge-a .cm-changedLineGutter": {
    background: REMOVED_GUTTER,
  },
  "&.cm-merge-b .cm-changedText": {
    background: ADDED_TEXT,
    ...CHANGED_TEXT_SHAPE,
  },
  "&.cm-merge-b .cm-changedLine": {
    backgroundColor: ADDED_LINE,
  },
  "&.cm-merge-b .cm-changedLineGutter": {
    background: ADDED_GUTTER,
  },
  ...SHARED_RULES,
};

export const UNIFIED_DIFF_THEME = EditorView.theme(UNIFIED_CHANGE_RULES);
export const SPLIT_DIFF_THEME = EditorView.theme(SPLIT_CHANGE_RULES);

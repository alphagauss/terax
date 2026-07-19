export { AiDiffView } from "./AiDiffViewLazy";
export type { EditorPaneHandle } from "./EditorPane";
export { EditorView } from "./EditorViewLazy";
export { GitDiffView } from "./GitDiffViewLazy";
export {
  type DiagnosticCounts,
  useDiagnosticsStore,
} from "./lib/diagnosticsStore";
export {
  countDirtyDocuments,
  hasOtherDocumentView,
  isDocumentTab,
} from "./lib/documentTabs";
export { useApplyEditorFontSize } from "./lib/useApplyEditorFontSize";
export { NewEditorDialog } from "./NewEditorDialog";
export { useEditorFileSync } from "./useEditorFileSync";

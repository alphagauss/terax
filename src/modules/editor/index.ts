/**
 * 本文件集中导出编辑器模块的视图、状态和工作区协调接口。
 */

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
export { NewEditorDialog } from "./NewEditorDialog";
export { useEditorFileSync } from "./useEditorFileSync";

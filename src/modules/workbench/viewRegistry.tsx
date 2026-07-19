import { cn } from "@/lib/utils";
import {
  AiDiffView,
  type EditorPaneHandle,
  EditorView,
  GitDiffView,
} from "@/modules/editor";
import type { FindHandle } from "@/modules/find";
import { GitHistoryView } from "@/modules/git-history";
import { MarkdownView } from "@/modules/markdown";
import type { MarkdownPreviewPaneHandle } from "@/modules/markdown/MarkdownPreviewPane";
import { type WebPreviewPaneHandle, WebPreviewView } from "@/modules/preview";
import { type TerminalPaneHandle, TerminalView } from "@/modules/terminal";
import type { Tab } from "@/modules/workbench/types";

type CommitFileDiffOpenInput = {
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
};

export type WorkbenchViewServices = {
  registerTerminalHandle: (
    terminalId: number,
    handle: TerminalPaneHandle | null,
  ) => void;
  onTerminalCwd: (terminalId: number, cwd: string) => void;
  onTerminalExit: (terminalId: number, code: number) => void;
  onFocusTab: (tabId: number) => void;
  registerEditorHandle: (
    tabId: number,
    handle: EditorPaneHandle | null,
  ) => void;
  registerMarkdownNavigationHandle: (
    tabId: number,
    handle: MarkdownPreviewPaneHandle | null,
  ) => void;
  onEditorDirtyChange: (tabId: number, dirty: boolean) => void;
  onEditorCloseTab: (tabId: number) => void;
  registerWebPreviewHandle: (
    tabId: number,
    handle: WebPreviewPaneHandle | null,
  ) => void;
  onWebPreviewUrlChange: (tabId: number, url: string) => void;
  onAiDiffAccept: (approvalId: string) => void;
  onAiDiffReject: (approvalId: string) => void;
  onOpenCommitFile: (input: CommitFileDiffOpenInput) => void;
  onGitHistoryFindHandle: (tabId: number, handle: FindHandle | null) => void;
};

type Props = {
  tab: Tab;
  visible: boolean;
  focused: boolean;
  services: WorkbenchViewServices;
};

export function WorkbenchRegisteredView({
  tab,
  visible,
  focused,
  services,
}: Props) {
  if (tab.cold) return null;

  return (
    <div
      className={cn(
        "workspace-surface absolute inset-0",
        tab.kind === "terminal" &&
          "workspace-terminal-surface pt-2 pr-0 pb-2 pl-3",
        tab.kind !== "terminal" &&
          tab.kind !== "git-history" &&
          "pt-2 pr-0 pb-2 pl-3",
      )}
    >
      {tab.kind === "terminal" && (
        <TerminalView
          tab={tab}
          visible={visible}
          focused={focused}
          registerHandle={services.registerTerminalHandle}
          onCwd={services.onTerminalCwd}
          onExit={services.onTerminalExit}
        />
      )}
      {tab.kind === "editor" && (
        <EditorView
          tab={tab}
          focused={focused}
          registerHandle={services.registerEditorHandle}
          onDirtyChange={services.onEditorDirtyChange}
          onCloseTab={services.onEditorCloseTab}
        />
      )}
      {tab.kind === "markdown" && (
        <MarkdownView
          tab={tab}
          visible={visible}
          focused={focused}
          registerEditorHandle={services.registerEditorHandle}
          registerNavigationHandle={services.registerMarkdownNavigationHandle}
          onDirtyChange={services.onEditorDirtyChange}
          onCloseTab={services.onEditorCloseTab}
        />
      )}
      {tab.kind === "web-preview" && (
        <WebPreviewView
          tab={tab}
          visible={visible}
          registerHandle={services.registerWebPreviewHandle}
          onUrlChange={services.onWebPreviewUrlChange}
        />
      )}
      {tab.kind === "ai-diff" && (
        <AiDiffView
          tab={tab}
          onAccept={services.onAiDiffAccept}
          onReject={services.onAiDiffReject}
        />
      )}
      {(tab.kind === "git-diff" || tab.kind === "git-commit-file") && (
        <GitDiffView tab={tab} visible={visible} />
      )}
      {tab.kind === "git-history" && (
        <GitHistoryView
          tab={tab}
          visible={visible}
          onOpenCommitFile={services.onOpenCommitFile}
          onFindHandle={services.onGitHistoryFindHandle}
        />
      )}
    </div>
  );
}

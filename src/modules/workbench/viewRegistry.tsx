import { cn } from "@/lib/utils";
import type { EditorPaneHandle } from "@/modules/editor";
import { AiDiffStack, EditorStack, GitDiffStack } from "@/modules/editor";
import type { GitHistorySearchHandle } from "@/modules/git-history";
import { GitHistoryStack } from "@/modules/git-history";
import { MarkdownStack } from "@/modules/markdown";
import type { MarkdownPreviewPaneHandle } from "@/modules/markdown/MarkdownPreviewPane";
import type { PreviewPaneHandle } from "@/modules/preview";
import { PreviewStack } from "@/modules/preview";
import type { TerminalPaneHandle } from "@/modules/terminal";
import { TerminalView } from "@/modules/terminal";
import type { Tab } from "@/modules/workbench/types";
import type { SearchAddon } from "@xterm/addon-search";

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
  onSearchReady: (terminalId: number, addon: SearchAddon) => void;
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
  registerPreviewHandle: (
    tabId: number,
    handle: PreviewPaneHandle | null,
  ) => void;
  onPreviewUrlChange: (tabId: number, url: string) => void;
  onAiDiffAccept: (approvalId: string) => void;
  onAiDiffReject: (approvalId: string) => void;
  onOpenCommitFile: (input: CommitFileDiffOpenInput) => void;
  onGitHistorySearchHandle: (
    tabId: number,
    handle: GitHistorySearchHandle | null,
  ) => void;
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
  const tabs = [tab];
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
          onSearchReady={services.onSearchReady}
          onCwd={services.onTerminalCwd}
          onExit={services.onTerminalExit}
          onFocus={services.onFocusTab}
        />
      )}
      {tab.kind === "editor" && (
        <EditorStack
          tabs={tabs}
          activeId={tab.id}
          registerHandle={services.registerEditorHandle}
          onDirtyChange={services.onEditorDirtyChange}
          onCloseTab={services.onEditorCloseTab}
        />
      )}
      {tab.kind === "markdown" && (
        <MarkdownStack
          tabs={tabs}
          activeId={tab.id}
          registerEditorHandle={services.registerEditorHandle}
          registerNavigationHandle={services.registerMarkdownNavigationHandle}
          onDirtyChange={services.onEditorDirtyChange}
          onCloseTab={services.onEditorCloseTab}
        />
      )}
      {tab.kind === "preview" && (
        <PreviewStack
          tabs={tabs}
          activeId={tab.id}
          registerHandle={services.registerPreviewHandle}
          onUrlChange={services.onPreviewUrlChange}
        />
      )}
      {tab.kind === "ai-diff" && (
        <AiDiffStack
          tabs={tabs}
          activeId={tab.id}
          onAccept={services.onAiDiffAccept}
          onReject={services.onAiDiffReject}
        />
      )}
      {(tab.kind === "git-diff" || tab.kind === "git-commit-file") && (
        <GitDiffStack tabs={tabs} activeId={tab.id} />
      )}
      {tab.kind === "git-history" && (
        <GitHistoryStack
          tabs={tabs}
          activeId={tab.id}
          onOpenCommitFile={services.onOpenCommitFile}
          onSearchHandle={(handle) =>
            services.onGitHistorySearchHandle(tab.id, handle)
          }
        />
      )}
    </div>
  );
}

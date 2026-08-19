/**
 * 本文件把按会话保存的工具审批请求渲染为持续应用内通知。
 * Toast 只负责展示和操作，实际响应与文件预览仍由审批运行时持有。
 */

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  Edit02Icon,
  FileEditIcon,
  FilePlusIcon,
  FolderAddIcon,
  TerminalIcon,
  Tick02Icon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useApprovalStore, type ApprovalRequest } from "../store/approvalStore";
import { useChatStore } from "../store/chatStore";

export type ApprovalDiffOpenInput = {
  requestKey: string;
  sessionId: string;
  path: string;
  originalContent: string;
  proposedContent: string;
  isNewFile: boolean;
};

export type ApprovalToastHostProps = {
  openDiff: (input: ApprovalDiffOpenInput) => number | null;
  onResolved: (requestKey: string, status: "approved" | "rejected") => void;
};

const TOOL_META: Record<
  string,
  { labelKey: string; icon: typeof FilePlusIcon }
> = {
  write_file: { labelKey: "toolApproval.writeFile", icon: FilePlusIcon },
  edit: { labelKey: "toolApproval.editFile", icon: FileEditIcon },
  multi_edit: { labelKey: "toolApproval.editFileBatch", icon: Edit02Icon },
  create_directory: {
    labelKey: "toolApproval.createDirectory",
    icon: FolderAddIcon,
  },
  bash_run: { labelKey: "toolApproval.runShellCommand", icon: TerminalIcon },
  bash_background: {
    labelKey: "toolApproval.spawnBackgroundProcess",
    icon: TerminalIcon,
  },
};

/** 将审批 store 中的每个请求同步为不可超时的稳定 toast。 */
export function ApprovalToastHost({
  openDiff,
  onResolved,
}: ApprovalToastHostProps) {
  const requests = useApprovalStore((state) => state.requests);
  const shown = useRef<Set<string>>(new Set());

  useEffect(() => {
    const active = new Set(Object.keys(requests));
    for (const key of shown.current) {
      if (!active.has(key)) toast.dismiss(key);
    }
    for (const request of Object.values(requests)) {
      toast.custom(
        () => (
          <ApprovalToast
            request={request}
            openDiff={openDiff}
            onResolved={onResolved}
          />
        ),
        {
          id: request.key,
          duration: Infinity,
          dismissible: false,
          closeButton: false,
        },
      );
    }
    shown.current = active;
  }, [onResolved, openDiff, requests]);

  useEffect(
    () => () => {
      for (const key of shown.current) toast.dismiss(key);
      shown.current.clear();
    },
    [],
  );

  return null;
}

function ApprovalToast({
  request,
  openDiff,
  onResolved,
}: {
  request: ApprovalRequest;
  openDiff: ApprovalToastHostProps["openDiff"];
  onResolved: ApprovalToastHostProps["onResolved"];
}) {
  const { t } = useTranslation("ai");
  const meta = TOOL_META[request.toolName];
  const Icon = meta?.icon ?? ToolsIcon;
  const sessionTitle = useChatStore(
    (state) =>
      state.sessions.find((session) => session.id === request.sessionId)
        ?.title ?? t("miniWindow.newChat"),
  );
  const responding = request.status === "responding";
  const isFile = request.preview !== null || isFileTool(request.toolName);

  const respond = (approved: boolean) => {
    if (!useApprovalStore.getState().respond(request.key, approved)) return;
    onResolved(request.key, approved ? "approved" : "rejected");
  };

  const review = () => {
    const preview = request.preview;
    if (!preview) return;
    openDiff({
      requestKey: request.key,
      sessionId: request.sessionId,
      path: preview.path,
      originalContent: preview.before,
      proposedContent: preview.after,
      isNewFile: preview.isNewFile,
    });
  };

  return (
    <div className="w-[360px] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-warning" />
        <HugeiconsIcon
          icon={Icon}
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
          {meta ? t(meta.labelKey) : request.toolName}
        </span>
        <span
          className="max-w-28 truncate text-[10px] text-muted-foreground"
          title={`${sessionTitle}: ${t("toolApproval.needsApproval")}`}
        >
          {sessionTitle}
        </span>
      </div>

      <button
        type="button"
        onClick={review}
        disabled={!request.preview}
        className={cn(
          "block w-full px-3 py-2.5 text-left",
          request.preview && "hover:bg-interactive-hover",
          !request.preview && "cursor-default",
        )}
      >
        <ApprovalSummary request={request} />
      </button>

      <div className="flex items-center justify-end gap-1.5 border-t border-border/60 px-3 py-2">
        {isFile && request.preview ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={review}
            disabled={responding}
            className="mr-auto h-7 text-[11px]"
          >
            {t("toolApproval.review")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => respond(false)}
          disabled={responding}
          className="h-7 gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
          {t("toolApproval.deny")}
        </Button>
        <Button
          size="sm"
          onClick={() => respond(true)}
          disabled={
            responding ||
            Boolean(request.previewError) ||
            (isFile && !request.preview)
          }
          className="h-7 gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
          {t("toolApproval.approve")}
        </Button>
      </div>
    </div>
  );
}

function ApprovalSummary({ request }: { request: ApprovalRequest }) {
  const { t } = useTranslation("ai");
  if (request.previewError) {
    return (
      <div className="space-y-1">
        <div className="font-mono text-[11px] text-muted-foreground">
          {String(request.input.path ?? "")}
        </div>
        <div className="text-[10.5px] text-destructive">
          {request.previewError}
        </div>
      </div>
    );
  }
  if (request.preview) {
    return (
      <div className="space-y-1">
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {request.preview.path}
        </div>
        <div className="text-[10.5px] text-muted-foreground">
          {t("toolApproval.openDiffHint")}
        </div>
      </div>
    );
  }
  if (isFileTool(request.toolName)) {
    return (
      <div className="text-[10.5px] text-muted-foreground">
        {t("toolApproval.preparingPreview")}
      </div>
    );
  }
  if (
    request.toolName === "bash_run" ||
    request.toolName === "bash_background"
  ) {
    return (
      <div className="space-y-1.5">
        {typeof request.input.cwd === "string" ? (
          <div className="font-mono text-[10.5px] text-muted-foreground">
            {request.input.cwd}
          </div>
        ) : null}
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
          {String(request.input.command ?? "")}
        </pre>
      </div>
    );
  }
  return (
    <div className="font-mono text-[11px] text-muted-foreground">
      {String(request.input.path ?? JSON.stringify(request.input))}
    </div>
  );
}

function isFileTool(toolName: string): boolean {
  return (
    toolName === "write_file" ||
    toolName === "edit" ||
    toolName === "multi_edit"
  );
}

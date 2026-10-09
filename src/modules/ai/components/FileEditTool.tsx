/** 文件工具的轻量展示行，不渲染流式文件正文；失败时沿用折叠详情。 */
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  describeToolCall,
  formatToolSummary,
} from "@/modules/ai/lib/toolSummary";
import { FileEditStats } from "@/modules/ai/components/FileEditStats";
import { FileEditIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslation } from "react-i18next";

export function FileEditTool({
  toolName,
  toolCallId,
  input,
  state,
  errorText,
}: {
  toolName: string;
  toolCallId: string;
  input: unknown;
  state: string;
  errorText?: string;
}) {
  const { t } = useTranslation("ai");
  const failed = state === "output-error";
  const denied = state === "output-denied";
  return (
    <Collapsible className="ai-tool-details">
      <CollapsibleTrigger
        disabled={!errorText}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-[3px] text-left text-xs leading-4 hover:bg-muted/60 disabled:hover:bg-transparent"
      >
        <span
          className={`size-1.5 shrink-0 rounded-full ${failed || denied ? "bg-destructive" : state === "output-available" ? "bg-success" : "bg-muted-foreground"}`}
        />
        <HugeiconsIcon
          icon={FileEditIcon}
          size={13}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium">
          {toolName}
        </span>
        <span className="min-w-0 truncate font-mono text-muted-foreground">
          {formatToolSummary(
            describeToolCall(toolName, input, state !== "input-streaming"), t,
          )}
        </span>
        {!denied && (
          <FileEditStats
            toolCallId={toolCallId}
            className="ml-1 inline-flex shrink-0"
          />
        )}
        {failed && (
          <span className="shrink-0 text-destructive">
            {t("chat.fileEdits.failed")}
          </span>
        )}
      </CollapsibleTrigger>
      {errorText && (
        <CollapsibleContent className="terax-collapsible-content">
          <pre className="ml-3 max-h-48 overflow-auto border-l border-border/60 p-2 text-xs text-destructive">
            {errorText}
          </pre>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

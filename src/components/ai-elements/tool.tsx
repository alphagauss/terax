/**
 * 本文件实现 AI 工具调用的紧凑状态行和按需详情渲染。
 * 工具详情默认折叠，稳定关闭后卸载输入输出子树以避免长会话持续占用渲染资源。
 */

"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  File01Icon,
  FolderOpenIcon,
  GlobalSearchIcon,
  TerminalIcon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, memo, useState } from "react";
import { useTranslation } from "react-i18next";

export type ToolPart = ToolUIPart | DynamicToolUIPart;

const TOOL_META: Record<string, { icon: typeof File01Icon }> = {
  read_file: { icon: File01Icon },
  find_files: { icon: FolderOpenIcon },
  file_operation: { icon: ToolsIcon },
  shell_exec: { icon: TerminalIcon },
  shell_process: { icon: TerminalIcon },
  shell_list: { icon: TerminalIcon },
  grep: { icon: GlobalSearchIcon },
};

const STATUS_DOT: Record<ToolPart["state"], string> = {
  "approval-requested": "bg-amber-500",
  "approval-responded": "bg-sky-500",
  "input-streaming": "bg-muted-foreground/40",
  "input-available": "bg-amber-500",
  "output-available": "bg-transparent border border-muted-foreground/40",
  "output-denied": "bg-orange-500",
  "output-error": "bg-destructive",
};

const STATUS_LABEL: Record<ToolPart["state"], string> = {
  "approval-requested": "awaiting approval",
  "approval-responded": "responded",
  "input-streaming": "preparing",
  "input-available": "running",
  "output-available": "done",
  "output-denied": "denied",
  "output-error": "error",
};

export type ToolProps = ComponentProps<typeof Collapsible> & {
  toolName: string;
  state: ToolPart["state"];
  summary?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

const ToolImpl = ({
  className,
  toolName,
  state,
  summary,
  input,
  output,
  errorText,
  defaultOpen,
  ...props
}: ToolProps) => {
  const meta = TOOL_META[toolName];
  const Icon = meta?.icon ?? ToolsIcon;
  const isError = state === "output-error";
  const showInputBody = input != null;
  const showOutputBody = output != null;
  const hasDetails =
    showInputBody || showOutputBody || Boolean(errorText);

  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className={cn("group/tool not-prose w-full", className)}
      {...props}
    >
      <CollapsibleTrigger
        disabled={!hasDetails}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
          "text-[12px] transition-colors",
          "hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <span
          className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[state])}
          aria-label={STATUS_LABEL[state]}
        />
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">{toolName}</span>
        {summary ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {isError && (
          <span className="shrink-0 text-[10px] font-medium text-destructive">
            failed
          </span>
        )}
      </CollapsibleTrigger>

      {hasDetails && (
        <CollapsibleContent
          className={cn("terax-collapsible-content")}
        >
          <div className="ml-3 mt-1 space-y-1 border-l border-border/60 pl-3 pb-1">
            {showInputBody ? (
              <ToolInput input={input} />
            ) : null}
            {showOutputBody || errorText ? (
              <div
                className={showInputBody ? "border-t border-border/60 pt-1" : undefined}
              >
                <ToolOutput
                  toolName={toolName}
                  output={showOutputBody ? output : undefined}
                  errorText={errorText}
                />
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
};

/** 工具详情按需挂载，状态行只显示宿主传入的轻量摘要。 */
export const Tool = memo(ToolImpl);

function ToolInput({ input }: { input: unknown }) {
  if (input == null) return null;
  return <CodeBlockMini code={JSON.stringify(input, null, 2)} />;
}

function ToolOutput({
  toolName,
  output,
  errorText,
}: {
  toolName: string;
  output: unknown;
  errorText?: string;
}) {
  const { t } = useTranslation("ai");
  if (errorText) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] font-medium text-destructive">
          {t("chat.toolDetails.error")}
        </div>
        <div className="rounded bg-destructive/10 px-2 py-1.5 font-mono text-[11px] text-destructive whitespace-pre-wrap">
          {errorText}
        </div>
      </div>
    );
  }
  if (output === undefined || output === null) return null;

  const custom = renderToolOutput(toolName, output);
  if (custom) return custom;
  if (typeof output === "string") {
    return <CodeBlockMini code={output} />;
  }
  if (typeof output === "object" && !isValidElement(output)) {
    return (
      <CodeBlockMini code={JSON.stringify(output, null, 2)} />
    );
  }
  return <div className="text-[12px]">{output as ReactNode}</div>;
}

function renderToolOutput(toolName: string, output: unknown): ReactNode | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;

  if (toolName === "read_file") {
    const path = typeof o.path === "string" ? o.path : "";
    const size = typeof o.size === "number" ? o.size : null;
    const content = typeof o.content === "string" ? o.content : "";
    const lines = content ? content.split("\n").length : null;
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">read</span>
        {path ? <span className="text-muted-foreground">· {path}</span> : null}
        {lines != null ? (
          <span className="text-muted-foreground">
            ({lines} line{lines === 1 ? "" : "s"}
            {size != null ? `, ${formatBytes(size)}` : ""})
          </span>
        ) : null}
      </div>
    );
  }

  if (toolName === "find_files") {
    const entries = Array.isArray(o.entries)
      ? (o.entries as Array<{ rel: string; kind: string }>)
      : [];
    if (entries.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">empty</div>
      );
    }
    const dirs = entries.filter(
      (e) => e.kind === "directory" || e.kind === "dir",
    );
    const files = entries.filter(
      (e) => !(e.kind === "directory" || e.kind === "dir"),
    );
    return (
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px]">
        {dirs.map((e) => (
          <div
            key={`d-${e.rel}`}
            className="flex items-center gap-1.5 truncate"
          >
            <HugeiconsIcon
              icon={FolderOpenIcon}
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate text-foreground">{e.rel}/</span>
          </div>
        ))}
        {files.map((e) => (
          <div
            key={`f-${e.rel}`}
            className="flex items-center gap-1.5 truncate"
          >
            <HugeiconsIcon
              icon={File01Icon}
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate text-muted-foreground">{e.rel}</span>
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "shell_exec" || toolName === "shell_process") {
    return <ShellProcessOutput data={o} />;
  }

  if (toolName === "shell_list") {
    const processes = Array.isArray(o.processes)
      ? (o.processes as Array<Record<string, unknown>>)
      : [];
    if (processes.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">
          no processes
        </div>
      );
    }
    return (
      <div className="space-y-1 font-mono text-[11px]">
        {processes.map((process) => (
          <div
            key={String(process.process_id)}
            className="flex items-center gap-1.5 rounded bg-muted/30 px-2 py-1"
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                process.status === "running"
                  ? "bg-emerald-500"
                  : "bg-muted-foreground/50",
              )}
            />
            <span className="min-w-0 flex-1 truncate">
              {String(process.command ?? "")}
            </span>
            <span className="text-muted-foreground">
              {String(process.status ?? "")}
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "grep") {
    const files = Array.isArray(o.files) ? (o.files as string[]) : [];
    const counts = Array.isArray(o.counts)
      ? (o.counts as Array<{ path: string; count: number }>)
      : [];
    const hits = Array.isArray(o.hits)
      ? (o.hits as Array<{
          rel?: string;
          path?: string;
          line: number;
          text: string;
        }>)
      : [];
    const truncated = Boolean(o.truncated);
    const filesScanned =
      typeof o.filesScanned === "number" ? o.filesScanned : null;

    if (files.length > 0 || counts.length > 0) {
      const rows = files.length > 0 ? files : counts.map((item) => `${item.path}: ${item.count}`);
      return (
        <div className="max-h-60 overflow-auto rounded bg-muted/30 px-2 py-1 font-mono text-[11px]">
          {rows.map((row) => (
            <div key={row} className="truncate text-muted-foreground">
              {row}
            </div>
          ))}
        </div>
      );
    }

    if (hits.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">
          no matches
          {filesScanned != null ? ` · ${filesScanned} files scanned` : ""}
        </div>
      );
    }

    return (
      <div className="space-y-1">
        <div className="max-h-72 overflow-auto rounded bg-muted/30 font-mono text-[11px]">
          {hits.slice(0, 200).map((h, idx) => (
            <div
              key={`${h.rel ?? h.path}-${h.line}-${idx}`}
              className="flex gap-2 border-b border-border/30 px-2 py-1 last:border-b-0 hover:bg-muted/60"
            >
              <span className="shrink-0 text-muted-foreground">
                {h.rel ?? h.path}:{h.line}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">
                {h.text}
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            {hits.length} hit{hits.length === 1 ? "" : "s"}
            {filesScanned != null ? ` · ${filesScanned} files` : ""}
          </span>
          {truncated ? (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-400">
              truncated
            </span>
          ) : null}
        </div>
      </div>
    );
  }


  return null;
}

function ShellProcessOutput({ data }: { data: Record<string, unknown> }) {
  const stdout = typeof data.stdout === "string" ? data.stdout : "";
  const stderr = typeof data.stderr === "string" ? data.stderr : "";
  const exit = typeof data.exit_code === "number" ? data.exit_code : null;
  const cwdAfter = typeof data.cwd_after === "string" ? data.cwd_after : null;
  const truncated = Boolean(data.truncated);
  const status = typeof data.status === "string" ? data.status : "";
  const processId =
    typeof data.process_id === "string" ? data.process_id : null;
  const timedOut = status === "timed_out";

  const hasStdout = stdout.length > 0;
  const hasStderr = stderr.length > 0;
  const initial = hasStdout ? "stdout" : hasStderr ? "stderr" : "stdout";
  const [tab, setTab] = useState<"stdout" | "stderr">(initial);

  const tabs: Array<{
    key: "stdout" | "stderr";
    label: string;
    count: number;
  }> = [
    { key: "stdout", label: "stdout", count: stdout.length },
    { key: "stderr", label: "stderr", count: stderr.length },
  ];

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors",
              tab === t.key
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:text-foreground",
              t.count === 0 && "opacity-40",
            )}
            disabled={t.count === 0}
          >
            {t.label}
            {t.count > 0 ? (
              <span className="ml-1 text-muted-foreground">{t.count}</span>
            ) : null}
          </button>
        ))}
        <span className="flex-1" />
        {status === "running" && processId ? (
          <span className="max-w-32 truncate rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:text-emerald-400">
            {processId}
          </span>
        ) : null}
        {exit != null ? (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px]",
              exit === 0
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                : "bg-destructive/15 text-destructive",
            )}
          >
            exit {exit}
          </span>
        ) : null}
        {timedOut ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            timed out
          </span>
        ) : null}
        {status === "terminated" ? (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            terminated
          </span>
        ) : null}
        {truncated ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            truncated
          </span>
        ) : null}
      </div>
      <pre className="max-h-72 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {tab === "stdout" ? stdout || " " : stderr || " "}
      </pre>
      {cwdAfter ? (
        <div className="font-mono text-[10px] text-muted-foreground">
          cwd → {cwdAfter}
        </div>
      ) : null}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function CodeBlockMini({ code }: { code: string }) {
  // 参数和结果按纯文本呈现，避免详情展开时额外加载语法高亮。
  return (
    <pre className="max-h-60 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap">
      {code}
    </pre>
  );
}

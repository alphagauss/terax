/**
 * 本文件实现聊天中的 Subagent 专用卡片。
 * 卡片展示实时最新动作、任务入参、工具过程和最终结果，不渲染子智能体推理正文。
 */

import { ExecutionProcesses } from "@/modules/ai/components/SessionProcesses";
import type { SubagentExecution } from "@/modules/ai/components/SubagentCards";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/controls/select";
import { Shimmer } from "@/components/controls/shimmer";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChatMessageResponse } from "@/modules/ai/components/ChatMessageResponse";
import { FileEditContext, FileEditStats } from "@/modules/ai/components/FileEditStats";
import { TaskUsageDetails } from "@/modules/ai/components/UsageDetails";
import { useChatDisplayActive } from "@/modules/ai/hooks/chatDisplay";
import {
  formatToolSummary,
  type ToolSummary,
} from "@/modules/ai/lib/toolSummary";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import RobotIcon from "@hugeicons/core-free-icons/Robot01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  SubagentDisplaySnapshot,
  SubagentDisplayState,
  SubagentDisplayStatus,
  SubagentDisplayStep,
} from "../agents/subagentDisplay";

type AnyToolPart = ToolUIPart | DynamicToolUIPart;
type Display = SubagentDisplayState | SubagentDisplaySnapshot;

export type SubagentResultView = {
  status: "completed" | "incomplete" | "failed" | "cancelled";
  result?: string;
  error?: string;
};

type Props = {
  sessionId?: string;
  part: AnyToolPart;
  display?: Display;
  backgroundResult?: SubagentResultView;
  executions?: SubagentExecution[];
};

type RunningAction =
  | { kind: "thinking"; key: "thinking" }
  | {
      kind: "tool";
      key: string;
      toolName: string;
      summary?: ToolSummary;
    };

type Headline =
  | { kind: "running"; action: RunningAction }
  | { kind: "terminal"; status: Exclude<SubagentDisplayStatus, "running"> };

const TOOL_HEADLINE_MIN_MS = 1000;

/**
 * Subagent 任务卡片。
 *
 * 标题中的工具动作至少保持一秒，新动作在此期间合并为最新状态；此计时只影响
 * 展示，不会阻塞子智能体、主 Agent 或持久化。
 */
export function SubagentCard({
  sessionId = "",
  part: originalPart,
  display: originalDisplay,
  backgroundResult,
  executions,
}: Props) {
  const { t } = useTranslation("ai");
  const fileEdits = useContext(FileEditContext);
  const [selectedId, setSelectedId] = useState<string>();
  const latest = executions?.[executions.length - 1];
  const selected = executions?.find((item) => (item.display.runId ?? item.part.toolCallId) === selectedId) ?? latest;
  const part = selected?.part ?? originalPart;
  const display = selected?.display ?? originalDisplay;
  const latestDisplay = latest?.display ?? originalDisplay;
  const selectedFileEdits = useMemo(() => selected
    ? { sessionId, calls: selected.fileEditCalls }
    : fileEdits, [sessionId, selected, fileEdits]);
  const latestStatus = resolveStatus(latest?.part ?? originalPart, latestDisplay, backgroundResult);
  const input = objectValue(part.input);
  const output = objectValue("output" in part ? part.output : undefined);
  const task = stringValue(input?.task) ?? stringValue(input?.message) ?? "";
  const status = resolveStatus(part, display, backgroundResult);
  const actualHeadline = useMemo(
    () => resolveHeadline(latestStatus, latestDisplay),
    [latestDisplay, latestStatus],
  );
  const headline = useStableHeadline(actualHeadline);
  const shownStatus =
    headline.kind === "terminal" ? headline.status : "running";
  const steps = display?.steps ?? [];
  const result =
    liveResult(display) ??
    resultFromObject(output) ??
    (selected ? undefined : backgroundResult) ??
    resultFromToolError(part);
  const [open, setOpen] = useState(false);
  const [chosenTab, setTab] = useState<"process" | "result" | "usage">();
  const tab = chosenTab ?? (status === "running" || status === "stopping" ? "process" : "result");
  const [taskOpen, setTaskOpen] = useState(false);
  const label = latestDisplay?.label ?? stringValue(input?.label) ?? t("chat.subagent.title");
  const taskId = latestDisplay?.taskId ?? stringValue(output?.taskId);
  const color = `var(--chart-${1 + [...(taskId ?? "")].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % 5})`;
  const statusLabel = (value: SubagentDisplayStatus) => t(`chat.subagent.${value === "incomplete" ? "stepLimit" : value}`);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="group/subagent overflow-hidden rounded-md border border-border/60 border-l-2 bg-muted/20"
      style={{ borderLeftColor: color }}
    >
      <CollapsibleTrigger className="flex w-full min-w-0 items-start gap-2 px-2 py-1.5 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <HugeiconsIcon
          icon={RobotIcon}
          size={13}
          strokeWidth={1.75}
          className="mt-0.5 shrink-0"
          style={{ color }}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-[12px] font-medium text-foreground">
              {label}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{taskId}</span>
            {latest && <span className="shrink-0 text-[10px] text-muted-foreground">
              {t("chat.subagent.execution", { number: latest.number })}
            </span>}
            {!open &&
              headline.kind === "running" &&
              headline.action.kind === "tool" && (
                <FileEditStats
                  toolCallId={headline.action.key}
                  taskId={display?.taskId}
                  className="ml-1 inline-flex shrink-0"
                />
              )}
            <span className="ml-auto inline-flex shrink-0">
              <StatusIcon status={shownStatus} />
            </span>
          </span>
          <span className="mt-0.5 block min-w-0 truncate text-[11px] text-muted-foreground">
            {headline.kind === "running" ? (
              <Shimmer as="span">
                {runningActionLabel(headline.action, t)}
              </Shimmer>
            ) : (
              terminalSummary(headline.status, latestDisplay?.steps.length ?? 0, latestDisplay, t)
            )}
          </span>
          <span className="block"><ExecutionProcesses runId={latestDisplay?.runId} /></span>
        </span>
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={11}
          strokeWidth={2}
          className={cn(
            "mt-0.5 shrink-0 text-muted-foreground transition-transform duration-control ease-emphasized",
            open && "rotate-90",
          )}
        />
      </CollapsibleTrigger>

      <CollapsibleContent className="terax-collapsible-content border-t border-border/30">
        <div className="space-y-2.5 px-2.5 py-2">
          {executions && selected && <>
            <div className="text-[10px] text-muted-foreground">
              {t("chat.subagent.turnExecutions", { count: executions.filter((item) => item.current).length })}
            </div>
            <Select value={selected.display.runId ?? selected.part.toolCallId} onValueChange={(id) => { setSelectedId(id === (latest?.display.runId ?? latest?.part.toolCallId) ? undefined : id); setTab(undefined); setTaskOpen(true); }}>
              <SelectTrigger size="sm" aria-label={t("chat.subagent.executions")} data-chat-scroll-preserve>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[true, false].map((current) => {
                  const items = executions.filter((item) => item.current === current);
                  return items.length > 0 && <SelectGroup key={String(current)}>
                    <SelectLabel>{t(current ? "chat.subagent.currentExecutions" : "chat.subagent.historyExecutions")}</SelectLabel>
                    {items.map((item) => <SelectItem key={item.display.runId ?? item.part.toolCallId} value={item.display.runId ?? item.part.toolCallId}>
                      {t("chat.subagent.execution", { number: item.number })} · {statusLabel(item.display.status)} · {(item.display.instructions?.[0] ?? "").replace(/\s+/g, " ").slice(0, 60)}
                    </SelectItem>)}
                  </SelectGroup>;
                })}
              </SelectContent>
            </Select>
            {selected !== latest && <button type="button" data-chat-scroll-preserve
              className="text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => { setSelectedId(undefined); setTab(undefined); }}>
              {t("chat.subagent.latestExecution", { number: latest?.number })} · {statusLabel(latestStatus)}
            </button>}
          </>}

          <ExecutionProcesses runId={display?.runId} />
          <Collapsible open={taskOpen} onOpenChange={setTaskOpen}>
            <CollapsibleTrigger className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground">
              <HugeiconsIcon icon={ArrowRight01Icon} size={10} className={cn(taskOpen && "rotate-90")} />
              {t("chat.subagent.task")}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1 whitespace-pre-wrap wrap-break-word text-[11.5px] leading-relaxed text-foreground">
                {display?.instructions?.[0] || task || t("chat.subagent.emptyTask")}
                {display?.instructions?.slice(1).map((instruction, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 补充要求在一次执行内只追加，正文与序号共同区分重复消息。
                  <div key={`${index}-${instruction}`} className="mt-2 border-t border-border/30 pt-2">
                    <span className="block text-[10px] text-muted-foreground">
                      {t("chat.subagent.additionalInstruction", { number: index + 1 })}
                    </span>
                    {instruction}
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="flex w-fit rounded-md bg-muted/50 p-0.5 text-[10.5px]">
            <TabButton
              active={tab === "process"}
              onClick={() => setTab("process")}
            >
              {t("chat.subagent.process", { count: steps.length })}
            </TabButton>
            <TabButton
              active={tab === "result"}
              onClick={() => setTab("result")}
            >
              {t("chat.subagent.result")}
            </TabButton>
            <TabButton active={tab === "usage"} onClick={() => setTab("usage")}>
              {t("miniWindow.context.taskUsage")}
            </TabButton>
          </div>

          <FileEditContext.Provider value={selectedFileEdits}>
          {tab === "process" ? (
            <ProcessList
              steps={steps}
              running={status === "running"}
              taskId={display?.taskId}
            />
          ) : tab === "usage" ? (
            <TaskUsageDetails
              sessionId={sessionId}
              runId={display?.runId}
              taskId={display?.taskId ?? stringValue(output?.taskId)}
            />
          ) : (
            <ResultPanel status={status} result={result} />
          )}
          </FileEditContext.Provider>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-chat-scroll-preserve
      className={cn(
        "rounded px-2 py-0.5 transition-colors",
        active
          ? "bg-background text-foreground shadow-xs"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function ProcessList({
  steps,
  running,
  taskId,
}: {
  steps: readonly SubagentDisplayStep[];
  running: boolean;
  taskId?: string;
}) {
  const { t } = useTranslation("ai");
  if (steps.length === 0) {
    return (
      <div className="rounded-md bg-muted/25 px-2 py-1.5 text-[11px] text-muted-foreground">
        {running ? t("chat.subagent.thinking") : t("chat.subagent.noToolCalls")}
      </div>
    );
  }
  return (
    <div className="max-h-56 space-y-0.5 overflow-auto pr-1">
      {steps.map((step) => (
        <div
          key={step.id}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px]"
        >
          <StepStatus status={step.status} />
          <span className="shrink-0 font-medium text-foreground">
            {step.toolName}
          </span>
          {step.summary ? (
            <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground">
              {formatToolSummary(step.summary, t)}
            </span>
          ) : null}
          <FileEditStats
            toolCallId={step.id}
            taskId={taskId}
            className="ml-1 inline-flex shrink-0"
          />
        </div>
      ))}
    </div>
  );
}

function ResultPanel({
  status,
  result,
}: {
  status: SubagentDisplayStatus;
  result?: SubagentResultView;
}) {
  const { t } = useTranslation("ai");
  if (status === "running" || status === "stopping") {
    return (
      <div className="rounded-md bg-muted/25 px-2 py-1.5 text-[11px] text-muted-foreground">
        {t(status === "stopping" ? "chat.subagent.stopping" : "chat.subagent.waitingResult")}
      </div>
    );
  }
  if (status === "cancelled") {
    return (
      <div className="rounded-md bg-muted/25 px-2 py-1.5 text-[11px] text-muted-foreground">
        {t("chat.subagent.cancelledResult")}
      </div>
    );
  }
  if (status === "incomplete" && !result?.result) {
    return (
      <div className="rounded-md border border-warning/30 bg-warning/5 px-2 py-1.5 text-[11px] text-muted-foreground">
        {t("chat.subagent.stepLimitResult")}
      </div>
    );
  }
  const content = result?.result ?? result?.error ?? "";
  if (!content) {
    return (
      <div className="rounded-md bg-muted/25 px-2 py-1.5 text-[11px] text-muted-foreground">
        {t("chat.subagent.emptyResult")}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "max-h-80 overflow-auto rounded-md border border-border/40 bg-background/60 px-2.5 py-2 text-[11.5px]",
        status === "failed" && "border-destructive/30 bg-destructive/5",
      )}
    >
      <ChatMessageResponse className="[&_*]:text-[11.5px]! [&_*]:leading-relaxed!">
        {content}
      </ChatMessageResponse>
    </div>
  );
}

function StatusIcon({ status }: { status: SubagentDisplayStatus }) {
  if (status === "completed") {
    return (
      <HugeiconsIcon
        icon={CheckmarkCircle02Icon}
        size={12}
        strokeWidth={2}
        className="shrink-0 text-success"
      />
    );
  }
  if (status === "incomplete") {
    return <span className="size-2 shrink-0 rounded-full bg-warning" />;
  }
  if (status === "failed" || status === "cancelled") {
    return (
      <HugeiconsIcon
        icon={Cancel01Icon}
        size={11}
        strokeWidth={2}
        className={cn(
          "shrink-0",
          status === "failed" ? "text-destructive" : "text-muted-foreground",
        )}
      />
    );
  }
  return <span className="size-1.5 shrink-0 rounded-full bg-warning" />;
}

function StepStatus({ status }: { status: SubagentDisplayStep["status"] }) {
  if (status === "running") {
    return <span className="size-1.5 shrink-0 rounded-full bg-warning" />;
  }
  if (status === "completed") {
    return (
      <HugeiconsIcon
        icon={CheckmarkCircle02Icon}
        size={11}
        strokeWidth={2}
        className="shrink-0 text-success"
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={Cancel01Icon}
      size={10}
      strokeWidth={2}
      className={cn(
        "shrink-0",
        status === "failed" ? "text-destructive" : "text-muted-foreground",
      )}
    />
  );
}

function resolveHeadline(
  status: SubagentDisplayStatus,
  display: Display | undefined,
): Headline {
  if (status !== "running") return { kind: "terminal", status };
  if (display && "phase" in display) {
    const active = [...display.steps]
      .reverse()
      .find((step) => step.status === "running");
    if (active && display.phase === "tool") {
      return {
        kind: "running",
        action: {
          kind: "tool",
          key: active.id,
          toolName: active.toolName,
          ...(active.summary ? { summary: active.summary } : {}),
        },
      };
    }
  }
  return { kind: "running", action: { kind: "thinking", key: "thinking" } };
}

/** 保证当前标题工具动作至少可见一秒，并把期间的新状态合并为最新值。 */
function useStableHeadline(actual: Headline): Headline {
  const active = useChatDisplayActive();
  const [shown, setShown] = useState(actual);
  const shownRef = useRef(shown);
  const pendingRef = useRef(actual);
  const shownAtRef = useRef(Date.now());

  useEffect(() => {
    shownRef.current = shown;
  }, [shown]);

  useEffect(() => {
    if (!active) return;
    pendingRef.current = actual;
    const current = shownRef.current;
    if (sameHeadline(current, actual)) return;
    // 同一调用补全摘要时立即更新，不能延长该工具动作的最短展示时间。
    if (
      current.kind === "running" &&
      actual.kind === "running" &&
      current.action.kind === "tool" &&
      actual.action.kind === "tool" &&
      current.action.key === actual.action.key
    ) {
      shownRef.current = actual;
      setShown(actual);
      return;
    }
    const elapsed = Date.now() - shownAtRef.current;
    const mustHold =
      current.kind === "running" &&
      current.action.kind === "tool" &&
      elapsed < TOOL_HEADLINE_MIN_MS;
    const applyLatest = () => {
      const next = pendingRef.current;
      shownAtRef.current = Date.now();
      shownRef.current = next;
      setShown(next);
    };
    if (!mustHold || (actual.kind === "terminal" && actual.status === "stopping")) {
      applyLatest();
      return;
    }
    const timer = window.setTimeout(
      applyLatest,
      TOOL_HEADLINE_MIN_MS - elapsed,
    );
    return () => window.clearTimeout(timer);
  }, [active, actual]);

  return shown;
}

function sameHeadline(left: Headline, right: Headline): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "terminal" && right.kind === "terminal") {
    return left.status === right.status;
  }
  return (
    left.kind === "running" &&
    right.kind === "running" &&
    left.action.kind === right.action.kind &&
    left.action.key === right.action.key &&
    (left.action.kind !== "tool" ||
      right.action.kind !== "tool" ||
      (left.action.toolName === right.action.toolName &&
        JSON.stringify(left.action.summary) ===
          JSON.stringify(right.action.summary)))
  );
}

function resolveStatus(
  part: AnyToolPart,
  display: Display | undefined,
  backgroundResult: SubagentResultView | undefined,
): SubagentDisplayStatus {
  if (display) return display.status;
  if (backgroundResult) return backgroundResult.status;
  const output = objectValue("output" in part ? part.output : undefined);
  const outputStatus = stringValue(output?.status);
  if (outputStatus === "stopping") return "stopping";
  if (outputStatus === "cancelled") return "cancelled";
  if (outputStatus === "completed") return "completed";
  if (outputStatus === "incomplete") return "incomplete";
  if (outputStatus === "failed" || outputStatus === "rejected") return "failed";
  if (part.state === "output-error" || part.state === "output-denied") {
    return "failed";
  }
  return "running";
}

function liveResult(
  display: Display | undefined,
): SubagentResultView | undefined {
  if (!display) return undefined;
  if (display.result !== undefined) {
    return {
      status: display.status === "incomplete" ? "incomplete" : "completed",
      result: display.result,
    };
  }
  if (display.error !== undefined) {
    return {
      status: display.status === "incomplete" ? "incomplete" : "failed",
      error: display.error,
    };
  }
  return undefined;
}

function resultFromObject(
  output: Record<string, unknown> | undefined,
): SubagentResultView | undefined {
  const status = stringValue(output?.status);
  if (
    status !== "completed" &&
    status !== "incomplete" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "rejected"
  ) {
    return undefined;
  }
  return {
    status:
      status === "cancelled"
        ? "cancelled"
        : status === "completed"
          ? "completed"
          : status === "incomplete"
            ? "incomplete"
            : "failed",
    ...(stringValue(output?.result) === undefined
      ? {}
      : { result: stringValue(output?.result) }),
    ...(stringValue(output?.error) === undefined
      ? {}
      : { error: stringValue(output?.error) }),
  };
}

function resultFromToolError(
  part: AnyToolPart,
): SubagentResultView | undefined {
  if (part.state !== "output-error") return undefined;
  const error = "errorText" in part ? part.errorText : undefined;
  return typeof error === "string" ? { status: "failed", error } : undefined;
}

function runningActionLabel(
  action: RunningAction,
  t: ReturnType<typeof useTranslation<"ai">>["t"],
): string {
  if (action.kind === "thinking") return t("chat.subagent.thinking");
  const label = action.toolName;
  const summary = formatToolSummary(action.summary, t);
  return summary ? `${label} ${summary}` : label;
}

function terminalSummary(
  status: Exclude<SubagentDisplayStatus, "running">,
  stepCount: number,
  display: Display | undefined,
  t: ReturnType<typeof useTranslation<"ai">>["t"],
): string {
  if (status === "stopping") return t("chat.subagent.stopping");
  if (status === "failed") return t("chat.subagent.failed");
  if (status === "cancelled") return t("chat.subagent.cancelled");
  if (status === "incomplete") return t("chat.subagent.stepLimit");
  const duration = display?.durationMs;
  return duration === undefined
    ? t("chat.subagent.completedCalls", { count: stepCount })
    : t("chat.subagent.completedSummary", {
        count: stepCount,
        duration: formatDuration(duration),
      });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function formatDuration(durationMs: number): string {
  const seconds = durationMs / 1000;
  return seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toString();
}

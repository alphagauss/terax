/**
 * 本文件实现聊天中的 Subagent 专用卡片。
 * 卡片展示实时最新动作、任务入参、工具过程和最终结果，不渲染子智能体推理正文。
 */

import { Shimmer } from "@/components/controls/shimmer";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChatMessageResponse } from "@/modules/ai/components/ChatMessageResponse";
import { FileEditStats } from "@/modules/ai/components/FileEditStats";
import { TaskUsageDetails } from "@/modules/ai/components/UsageDetails";
import { useChatDisplayActive } from "@/modules/ai/hooks/chatDisplay";
import {
  describeToolCall,
  formatToolSummary,
  type ToolSummary,
} from "@/modules/ai/lib/toolSummary";
import {
  ArrowRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  RobotIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
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
  part,
  display,
  backgroundResult,
}: Props) {
  const { t } = useTranslation("ai");
  const toolName =
    part.type === "tool-subagent_task" ||
    ("toolName" in part && part.toolName === "subagent_task")
      ? "subagent_task"
      : "run_subagent";
  const input = objectValue(part.input);
  const output = objectValue("output" in part ? part.output : undefined);
  const task = stringValue(input?.task) ?? stringValue(input?.message) ?? "";
  const status = resolveStatus(part, display, backgroundResult);
  const actualHeadline = useMemo(
    () => resolveHeadline(status, display),
    [display, status],
  );
  const headline = useStableHeadline(actualHeadline);
  const shownStatus =
    headline.kind === "terminal" ? headline.status : "running";
  const steps = display?.steps ?? [];
  const result =
    liveResult(display) ??
    resultFromObject(output) ??
    backgroundResult ??
    resultFromToolError(part);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"process" | "result" | "usage">(() =>
    status === "running" ? "process" : "result",
  );
  const [taskOpen, setTaskOpen] = useState(false);
  const taskCanExpand = task.length > 180 || task.split("\n").length > 3;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="group/subagent overflow-hidden rounded-md border border-border/50 bg-card/50"
    >
      <CollapsibleTrigger className="flex w-full min-w-0 items-start gap-2 px-2 py-1.5 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <HugeiconsIcon
          icon={RobotIcon}
          size={13}
          strokeWidth={1.75}
          className="mt-0.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-[12px] font-medium text-foreground">
              {toolName}
            </span>
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
              {formatToolSummary(
                describeToolCall(
                  toolName,
                  input ?? { label: display?.label },
                  part.state !== "input-streaming",
                ),
                t,
              )}
            </span>
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
              terminalSummary(headline.status, steps.length, display, t)
            )}
          </span>
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
          <section>
            <div className="text-[10px] font-medium text-muted-foreground">
              {t("chat.subagent.task")}
            </div>
            <div
              className={cn(
                "mt-1 whitespace-pre-wrap wrap-break-word text-[11.5px] leading-relaxed text-foreground/85",
                !taskOpen && taskCanExpand && "line-clamp-3",
              )}
            >
              {task || t("chat.subagent.emptyTask")}
            </div>
            {taskCanExpand ? (
              <button
                type="button"
                onClick={() => setTaskOpen((value) => !value)}
                className="mt-1 text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {taskOpen
                  ? t("chat.subagent.collapse")
                  : t("chat.subagent.expand")}
              </button>
            ) : null}
          </section>

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

          {tab === "process" ? (
            <ProcessList
              steps={steps}
              running={status === "running"}
              taskId={display?.taskId}
            />
          ) : tab === "usage" ? (
            <TaskUsageDetails
              sessionId={sessionId}
              taskId={display?.taskId ?? stringValue(output?.taskId)}
            />
          ) : (
            <ResultPanel status={status} result={result} />
          )}
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
          <span className="shrink-0 font-medium text-foreground/90">
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
  if (status === "running") {
    return (
      <div className="rounded-md bg-muted/25 px-2 py-1.5 text-[11px] text-muted-foreground">
        {t("chat.subagent.waitingResult")}
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
        className="shrink-0 text-emerald-500"
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
    return <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />;
  }
  if (status === "completed") {
    return (
      <HugeiconsIcon
        icon={CheckmarkCircle02Icon}
        size={11}
        strokeWidth={2}
        className="shrink-0 text-emerald-500"
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
    if (!mustHold) {
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

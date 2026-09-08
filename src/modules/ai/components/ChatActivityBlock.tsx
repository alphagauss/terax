/**
 * 本文件实现聊天活动块的折叠标题和本地展开状态。
 * 不同工具的标题切换至少间隔一秒，同一调用的摘要立即更新；活动结束立即完成并收起一次。
 */

import { Shimmer } from "@/components/ai-elements/shimmer";
import { FileEditStats } from "@/modules/ai/components/FileEditStats";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type ChatActivityHeadline =
  | null
  | { kind: "thinking"; key: "thinking"; text: string }
  | { kind: "tool"; key: string; text: string; action?: string };

type Props = {
  children: ReactNode;
  durationMs?: number;
  headline: ChatActivityHeadline;
  running: boolean;
};

const TOOL_HEADLINE_MIN_MS = 1000;

/**
 * 一段思考和普通工具调用的统一折叠入口。
 *
 * 活动结束只强制收起一次，之后完全尊重用户选择；展开状态不跨会话持久化。
 */
export function ChatActivityBlock({
  children,
  durationMs,
  headline,
  running,
}: Props) {
  const { t } = useTranslation("ai");
  const [open, setOpen] = useState(false);
  const wasRunning = useRef(running);
  const shownHeadline = useStableHeadline(headline, running);
  const durationSeconds =
    durationMs === undefined
      ? undefined
      : Math.max(1, Math.ceil(durationMs / 1000));

  useLayoutEffect(() => {
    if (wasRunning.current && !running) setOpen(false);
    wasRunning.current = running;
  }, [running]);

  if (running && !shownHeadline) return null;

  const title = running
    ? (shownHeadline?.text ?? "")
    : durationSeconds === undefined
      ? t("chat.activity.completed")
      : t("chat.activity.completedWithDuration", {
          duration: durationSeconds,
        });

  return (
    <Collapsible
      className="ai-activity-block not-prose"
      open={open}
      onOpenChange={setOpen}
    >
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-1.5 text-[14px] leading-[22px] text-muted-foreground transition-colors duration-control hover:text-foreground">
        {running && shownHeadline?.kind === "tool" && shownHeadline.action && (
          <Shimmer
            as="span"
            className="shrink-0 whitespace-nowrap"
            sweepDuration={1.2}
            pauseDuration={0.6}
          >
            {shownHeadline.action}
          </Shimmer>
        )}
        {running ? (
          <Shimmer
            as="span"
            className={cn(
              "min-w-0 truncate text-left",
              shownHeadline?.kind === "tool" &&
                shownHeadline.action &&
                "font-mono",
            )}
            sweepDuration={1.2}
            pauseDuration={0.6}
          >
            {title}
          </Shimmer>
        ) : (
          <span className="min-w-0 truncate text-left">{title}</span>
        )}
        {!open && running && shownHeadline?.kind === "tool" && (
          <FileEditStats
            toolCallId={shownHeadline.key}
            className="ml-1 inline-flex shrink-0"
          />
        )}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={11}
          strokeWidth={1.75}
          className={cn(
            "shrink-0 transition-transform duration-control ease-emphasized",
            open ? "rotate-180" : "rotate-0",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="terax-collapsible-content outline-none">
        <div className="mt-1 flex flex-col gap-0.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 无摘要时保留已有标题；同一调用立即补全，其他活动合并切换，结束后取消候选。 */
function useStableHeadline(
  actual: ChatActivityHeadline,
  running: boolean,
): ChatActivityHeadline {
  const [shown, setShown] = useState({ value: actual, at: Date.now() });

  useLayoutEffect(() => {
    if (!running || !actual) return;
    const current = shown.value;
    if (
      current?.kind === actual.kind &&
      current.key === actual.key &&
      current.text === actual.text &&
      (current.kind !== "tool" ||
        actual.kind !== "tool" ||
        current.action === actual.action)
    ) {
      return;
    }
    if (current?.kind === actual.kind && current.key === actual.key) {
      setShown({ value: actual, at: shown.at });
      return;
    }
    const remaining =
      current?.kind === "tool"
        ? TOOL_HEADLINE_MIN_MS - (Date.now() - shown.at)
        : 0;
    if (remaining <= 0) {
      setShown({ value: actual, at: Date.now() });
      return;
    }
    const timer = window.setTimeout(
      () => setShown({ value: actual, at: Date.now() }),
      remaining,
    );
    return () => window.clearTimeout(timer);
  }, [actual, running, shown]);

  return shown.value;
}

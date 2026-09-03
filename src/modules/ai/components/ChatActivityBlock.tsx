/**
 * 本文件实现聊天活动块的折叠标题和本地展开状态。
 * 运行态标题稳定展示当前工具至少一秒，正文或 Subagent 到达时立即完成并自动收起一次。
 */

import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type ChatActivityHeadline =
  | { kind: "thinking"; key: "thinking"; text: string }
  | { kind: "tool"; key: string; text: string };

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
  const shownHeadline = useStableHeadline(headline);
  const durationSeconds =
    durationMs === undefined
      ? undefined
      : Math.max(1, Math.ceil(durationMs / 1000));

  useLayoutEffect(() => {
    if (wasRunning.current && !running) setOpen(false);
    wasRunning.current = running;
  }, [running]);

  const title = running
    ? shownHeadline.text
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
        {running ? (
          <Shimmer
            as="span"
            className="min-w-0 truncate text-left"
            sweepDuration={1.2}
            pauseDuration={0.6}
          >
            {title}
          </Shimmer>
        ) : (
          <span className="min-w-0 truncate text-left">{title}</span>
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

/** 当前工具标题至少展示一秒，期间到达的新动作合并为最新状态。 */
function useStableHeadline(actual: ChatActivityHeadline): ChatActivityHeadline {
  const [shown, setShown] = useState({ value: actual, at: Date.now() });

  useEffect(() => {
    const current = shown.value;
    if (
      current.kind === actual.kind &&
      current.key === actual.key &&
      current.text === actual.text
    ) {
      return;
    }
    const remaining =
      current.kind === "tool"
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
  }, [actual, shown]);

  return shown.value;
}

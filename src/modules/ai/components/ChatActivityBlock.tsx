/**
 * 本文件实现聊天活动块的折叠标题、本地展开状态和运行计时展示。
 * 不同工具的标题切换至少间隔一秒，同一调用的摘要立即更新；计时起点按会话保留，活动结束立即完成并收起一次。
 */
import {
  useChatDisplayActive,
  useChatDisplayStore,
} from "@/modules/ai/hooks/chatDisplay";

import { Shimmer } from "@/components/controls/shimmer";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { FileEditStats } from "@/modules/ai/components/FileEditStats";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { ChevronDown } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type ChatActivityHeadline =
  | null
  | { kind: "thinking"; key: "thinking" }
  | { kind: "tool"; key: string; text: string; action?: string };

type Props = {
  sessionId: string;
  activityKey: string;
  children: ReactNode;
  durationMs?: number;
  headline: ChatActivityHeadline;
  running: boolean;
};

const TOOL_HEADLINE_MIN_MS = 1000;

/**
 * 一段思考和普通工具调用的统一折叠入口。
 *
 * 活动结束只强制收起一次，之后完全尊重用户选择；展开状态不跨会话持久化，
 * 运行计时仅在内存中跨前后台挂载恢复。
 */
export function ChatActivityBlock({
  sessionId,
  activityKey,
  children,
  durationMs,
  headline,
  running,
}: Props) {
  const { t } = useTranslation("ai");
  const [open, setOpen] = useState(false);
  const wasRunning = useRef(running);
  const shownHeadline = useStableHeadline(headline, running);
  const localStartedAt = useRef(Date.now()).current;
  const activityTiming = useChatDisplayStore(useChatStore, (state) =>
    running ? state.agentMetaBySession[sessionId]?.activityTiming : undefined,
  );
  const patchAgentMeta = useChatStore((state) => state.patchAgentMeta);
  const startedAt =
    activityTiming?.key === activityKey
      ? activityTiming.startedAt
      : localStartedAt;
  const durationSeconds =
    durationMs === undefined
      ? undefined
      : Math.max(1, Math.ceil(durationMs / 1000));

  useLayoutEffect(() => {
    if (wasRunning.current && !running) setOpen(false);
    wasRunning.current = running;
  }, [running]);

  useLayoutEffect(() => {
    const current =
      useChatStore.getState().agentMetaBySession[sessionId]?.activityTiming;
    if (running) {
      if (current?.key !== activityKey) {
        patchAgentMeta(sessionId, {
          activityTiming: { key: activityKey, startedAt: localStartedAt },
        });
      }
    } else if (current?.key === activityKey) {
      patchAgentMeta(sessionId, { activityTiming: undefined });
    }
  }, [activityKey, localStartedAt, patchAgentMeta, running, sessionId]);

  if (running && !shownHeadline) return null;

  const title = running
    ? shownHeadline?.kind === "tool"
      ? shownHeadline.text
      : ""
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
      <CollapsibleTrigger className="group/ai-disclosure flex w-fit max-w-full min-w-0 items-center gap-1.5 text-[14px] leading-[22px] text-muted-foreground transition-colors duration-control hover:text-foreground">
        {running && shownHeadline?.kind === "thinking" ? (
          <ActivityThinkingTitle startedAt={startedAt} />
        ) : running ? (
          <Shimmer
            as="span"
            className="min-w-0 text-left"
            text={
              shownHeadline?.kind === "tool" && shownHeadline.action
                ? `${shownHeadline.action} ${title}`
                : title
            }
          >
            {shownHeadline?.kind === "tool" && shownHeadline.action ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 whitespace-nowrap">
                  {shownHeadline.action}
                </span>
                <span className="min-w-0 truncate font-mono">{title}</span>
              </span>
            ) : (
              title
            )}
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
          icon={ChevronDown}
          size={11}
          strokeWidth={1.75}
          className={cn(
            "shrink-0 opacity-0 transition-[opacity,transform] duration-control ease-emphasized group-hover/ai-disclosure:opacity-100 group-focus-visible/ai-disclosure:opacity-100",
            open ? "rotate-0 opacity-100" : "-rotate-90",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="terax-collapsible-content outline-none">
        <div className="mt-1 flex flex-col gap-0.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 只在思考标题可见时逐秒刷新，起点由会话级内存状态提供。 */
function ActivityThinkingTitle({ startedAt }: { startedAt: number }) {
  const active = useChatDisplayActive();
  const { t } = useTranslation("ai");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const duration = Math.max(1, Math.floor((now - startedAt) / 1000) + 1);
  return (
    <Shimmer as="span">
      {t("chat.activity.thinkingWithDuration", { duration })}
    </Shimmer>
  );
}

/** 无摘要时保留已有标题；同一调用立即补全，其他活动合并切换，结束后取消候选。 */
function useStableHeadline(
  actual: ChatActivityHeadline,
  running: boolean,
): ChatActivityHeadline {
  const active = useChatDisplayActive();
  const [shown, setShown] = useState({ value: actual, at: Date.now() });

  useLayoutEffect(() => {
    if (!active || !running || !actual) return;
    const current = shown.value;
    if (
      (current?.kind === "thinking" && actual.kind === "thinking") ||
      (current?.kind === "tool" &&
        actual.kind === "tool" &&
        current.key === actual.key &&
        current.text === actual.text &&
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
  }, [active, actual, running, shown]);

  return shown.value;
}

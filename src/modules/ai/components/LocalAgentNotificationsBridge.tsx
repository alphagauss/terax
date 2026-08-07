/**
 * 本文件把所有内置 AI 会话的运行状态接入统一 Agent 通知系统。
 * 后台会话的审批、完成和错误通知携带会话 ID，点击后切回对应会话。
 */

import { routeAgentNotification } from "@/modules/agents/lib/route";
import type { AgentStatus } from "@/modules/agents/lib/types";
import { useWindowFocus } from "@/modules/agents/lib/useWindowFocus";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useChatStore, type AgentRunStatus } from "../store/chatStore";

const AGENT = "Terax";

function isBusy(status: AgentRunStatus): boolean {
  return (
    status === "thinking" ||
    status === "streaming" ||
    status === "awaiting-approval"
  );
}

function aggregateStatus(
  runs: Record<string, { status: AgentRunStatus }>,
): AgentStatus | null {
  const statuses = Object.values(runs).map((run) => run.status);
  if (statuses.includes("awaiting-approval")) return "waiting";
  return statuses.some(isBusy) ? "working" : null;
}

/** 监听每个会话的状态转换，并为后台会话生成可导航通知。 */
export function LocalAgentNotificationsBridge({
  visible,
  onActivate,
}: {
  visible: boolean;
  onActivate: (sessionId?: string) => void;
}) {
  const { t } = useTranslation("ai");
  const runs = useChatStore((state) => state.agentMetaBySession);
  const sessions = useChatStore((state) => state.sessions);
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const focused = useWindowFocus();
  const previous = useRef<Record<string, AgentRunStatus>>({});

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const activeSessionRef = useRef(activeSessionId);
  activeSessionRef.current = activeSessionId;

  useEffect(() => {
    const nextLiveStatus = aggregateStatus(runs);
    useAgentStore
      .getState()
      .setLocalAgent(
        nextLiveStatus ? { agent: AGENT, status: nextLiveStatus } : null,
      );

    for (const [sessionId, run] of Object.entries(runs)) {
      const was = previous.current[sessionId] ?? "idle";
      if (was === run.status) continue;
      const sessionTitle =
        sessions.find((session) => session.id === sessionId)?.title ||
        t("miniWindow.newChat");
      const fire = (
        kind: "attention" | "finished" | "error",
        title: string,
        body?: string,
        allowToast = true,
      ) =>
        routeAgentNotification({
          source: "local",
          agent: AGENT,
          kind,
          title,
          body,
          focused: focusedRef.current,
          visible: visibleRef.current && activeSessionRef.current === sessionId,
          allowToast,
          sessionId,
          onActivate: () => onActivate(sessionId),
        });

      if (run.status === "awaiting-approval") {
        fire(
          "attention",
          t("notifications.approvalTitle", { session: sessionTitle }),
          t("notifications.approvalBody"),
          false,
        );
      } else if (run.status === "error") {
        fire(
          "error",
          t("notifications.errorTitle", { session: sessionTitle }),
          run.error ?? undefined,
        );
      } else if (run.status === "idle" && isBusy(was)) {
        fire(
          "finished",
          t("notifications.finishedTitle", { session: sessionTitle }),
          t("notifications.finishedBody"),
        );
      }
    }
    previous.current = Object.fromEntries(
      Object.entries(runs).map(([sessionId, run]) => [sessionId, run.status]),
    );
  }, [onActivate, runs, sessions, t]);

  useEffect(() => () => useAgentStore.getState().setLocalAgent(null), []);

  return null;
}

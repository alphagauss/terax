/**
 * 本文件把内置 AI 会话的可见性和运行结果接入关注状态及统一通知系统。
 * 后台提示只存在于内存，普通会话完成通知在结果提交并释放运行锁后发送；
 * Channel 完成状态由 Channels 入口负责，不进入统一通知列表。
 */

import { routeAgentNotification } from "@/modules/agents/lib/route";
import type { AgentStatus } from "@/modules/agents/lib/types";
import { useWindowFocus } from "@/modules/agents/lib/useWindowFocus";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { parseExternalAgentBinding } from "../external-agents/runtime";
import {
  type AgentRunStatus,
  sessionMetadata,
  useChatStore,
} from "../store/chatStore";
import { useSessionAttentionStore } from "../store/sessionAttentionStore";

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

function notificationAgent(sessionId: string): string {
  return (
    parseExternalAgentBinding(sessionMetadata.get(sessionId))?.agentId ?? AGENT
  );
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
  const runLockSessionIds = useChatStore((state) => state.runLockSessionIds);
  const pendingCompletionCount = useSessionAttentionStore(
    (state) => state.pendingCompletions.length,
  );
  const focused = useWindowFocus();
  const previous = useRef<Record<string, AgentRunStatus>>({});

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const activeSessionRef = useRef(activeSessionId);
  activeSessionRef.current = activeSessionId;

  useLayoutEffect(() => {
    const attention = useSessionAttentionStore.getState();
    for (const sessionId of Object.keys(runLockSessionIds)) {
      if (focused && visible && activeSessionId === sessionId) {
        attention.markViewed(sessionId);
      } else {
        attention.markBackgroundRunning(sessionId);
      }
    }
    if (focused && visible && activeSessionId) {
      attention.markViewed(activeSessionId);
      useAgentStore.getState().dismissNotificationsForTarget({
        source: "local",
        sessionId: activeSessionId,
      });
    }
  }, [activeSessionId, focused, runLockSessionIds, visible]);

  useEffect(() => {
    const interactiveRuns = Object.fromEntries(
      Object.entries(runs).filter(
        ([id]) => !sessions.find((session) => session.id === id)?.channelId,
      ),
    );
    const nextLiveStatus = aggregateStatus(interactiveRuns);
    const liveAgentIds = Object.entries(interactiveRuns)
      .filter(([, run]) => isBusy(run.status))
      .map(([sessionId]) => notificationAgent(sessionId));
    const liveAgent =
      new Set(liveAgentIds).size === 1 ? (liveAgentIds[0] ?? AGENT) : AGENT;
    useAgentStore
      .getState()
      .setLocalAgent(
        nextLiveStatus ? { agent: liveAgent, status: nextLiveStatus } : null,
      );

    for (const [sessionId, run] of Object.entries(runs)) {
      const was = previous.current[sessionId] ?? "idle";
      if (was === run.status) continue;
      if (run.status === "awaiting-approval") {
        const sessionTitle =
          sessions.find((session) => session.id === sessionId)?.title ||
          t("miniWindow.newChat");
        routeAgentNotification({
          source: "local",
          agent: notificationAgent(sessionId),
          kind: "attention",
          title: t("notifications.approvalTitle", { session: sessionTitle }),
          body: t("notifications.approvalBody"),
          focused: focusedRef.current,
          visible: visibleRef.current && activeSessionRef.current === sessionId,
          allowToast: false,
          sessionId,
          onActivate: () => onActivate(sessionId),
        });
      }
    }
    previous.current = Object.fromEntries(
      Object.entries(runs).map(([sessionId, run]) => [sessionId, run.status]),
    );
  }, [onActivate, runs, sessions, t]);

  useEffect(() => {
    if (pendingCompletionCount === 0) return;
    const attention = useSessionAttentionStore.getState();
    const completions = attention.takePendingCompletions();
    for (const completion of completions) {
      const session = useChatStore
        .getState()
        .sessions.find((candidate) => candidate.id === completion.sessionId);
      if (session?.channelId) {
        attention.markViewed(completion.sessionId);
        continue;
      }
      const sessionTitle = session?.title || t("miniWindow.newChat");
      const error =
        useChatStore.getState().agentMetaBySession[completion.sessionId]?.error;
      routeAgentNotification({
        source: "local",
        agent: notificationAgent(completion.sessionId),
        kind: completion.outcome === "error" ? "error" : "finished",
        title:
          completion.outcome === "error"
            ? t("notifications.errorTitle", { session: sessionTitle })
            : t("notifications.finishedTitle", { session: sessionTitle }),
        body:
          completion.outcome === "error"
            ? (error ?? undefined)
            : t("notifications.finishedBody"),
        focused: focusedRef.current,
        visible:
          visibleRef.current &&
          activeSessionRef.current === completion.sessionId,
        allowToast: true,
        sessionId: completion.sessionId,
        onActivate: () => onActivate(completion.sessionId),
      });
    }
  }, [onActivate, pendingCompletionCount, t]);

  useEffect(() => () => useAgentStore.getState().setLocalAgent(null), []);

  return null;
}

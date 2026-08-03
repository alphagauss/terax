/**
 * 本文件管理托管 Agent 的自动审查触发与待处理状态。
 * 每个 Agent 由其 Workbench 标签 ID 唯一定位。
 */

import { useChatStore } from "@/modules/ai/store/chatStore";
import {
  useManagedAgentsStore,
  type ManagedAgent,
} from "../store/managedAgentsStore";

function buildReviewDirective(m: ManagedAgent): string {
  const remaining = m.maxRounds - m.rounds;
  const lastRound =
    remaining <= 1
      ? " This is the last automatic review round, so make any follow-up count."
      : "";
  return `The Claude Code agent you are supervising has finished its turn on:

> ${m.task}

Call read_agent_output to see what it actually did and reported. Then decide: if the task is complete, confirm it is done (do not call send_to_agent); otherwise call send_to_agent with one precise follow-up.${lastRound}`;
}

function canReview(m: ManagedAgent): boolean {
  if (m.phase === "done") return false;
  if (m.rounds >= m.maxRounds) return false;
  if (m.reviewedAtRound >= m.rounds) return false;
  return true;
}

function fireReview(m: ManagedAgent): void {
  const store = useManagedAgentsStore.getState();
  store.markReviewed(m.tabId);
  store.setPhase(m.tabId, "reviewing");
  void (async () => {
    const { getOrCreateChat } = await import("@/modules/ai/store/chatRuntime");
    const chat = getOrCreateChat(m.sessionId);
    void chat.sendMessage({
      role: "user",
      parts: [{ type: "text", text: buildReviewDirective(m) }],
    } as Parameters<typeof chat.sendMessage>[0]);
  })();
}

/** 在托管 Agent 当前轮次满足条件时立即审查，否则记录待处理状态。 */
export function maybeTriggerManagedReview(tabId: number): void {
  const store = useManagedAgentsStore.getState();
  const m = store.get(tabId);
  if (!m || !canReview(m)) return;
  if (useChatStore.getState().activeSessionId !== m.sessionId) {
    store.setPendingReview(tabId, true);
    return;
  }
  fireReview(m);
}

/** 激活会话后触发其此前延迟的托管 Agent 审查。 */
export function firePendingReviewForSession(sessionId: string): void {
  const store = useManagedAgentsStore.getState();
  const m = store.getBySessionId(sessionId);
  if (!m?.pendingReview) return;
  if (!canReview(m)) {
    store.setPendingReview(m.tabId, false);
    return;
  }
  fireReview(m);
}

/**
 * 本文件抑制同一 Agent 目标短时间内产生的重复通知。
 * 缓存有固定上限，并允许系统时钟回拨后立即恢复投递。
 */

export const AGENT_NOTIFICATION_COOLDOWN_MS = 2_000;

const MAX_RECENT_NOTIFICATIONS = 64;

export type AgentNotificationKey = {
  source: string;
  agent: string;
  kind: string;
  tabId: number;
  sessionId?: string;
};

/** 创建有容量上限的通知去重判断器。 */
export function createAgentNotificationGate(
  cooldownMs = AGENT_NOTIFICATION_COOLDOWN_MS,
  maxEntries = MAX_RECENT_NOTIFICATIONS,
): (key: AgentNotificationKey, now?: number) => boolean {
  const recent = new Map<string, number>();

  return (key, now = Date.now()) => {
    const id = JSON.stringify([
      key.source,
      key.agent,
      key.kind,
      key.tabId,
      key.sessionId ?? null,
    ]);
    const previous = recent.get(id);
    if (
      previous !== undefined &&
      now >= previous &&
      now - previous < cooldownMs
    ) {
      return false;
    }

    recent.delete(id);
    recent.set(id, now);
    while (recent.size > maxEntries) {
      const oldest = recent.keys().next().value;
      if (oldest === undefined) break;
      recent.delete(oldest);
    }
    return true;
  };
}

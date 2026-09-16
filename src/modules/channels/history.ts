/** 所有出口的投递展示事实；与 Agent 共用会话文件，但不构造模型消息。 */
import { create } from "zustand";
import type { SessionMessage } from "@/modules/ai/lib/conversation";
import type {
  ChannelTarget,
  ChannelOutbound,
  ChannelDeliveryResult,
  ChannelDeliverySource,
} from "@/modules/channels/types";

export type DeliveryNotification =
  | { status: "error" | "ignored" }
  | { status: "retried"; retryId: string };

export type DeliveryRecord = { id: string } & (
  | {
      phase: "request";
      source: ChannelDeliverySource;
      target: ChannelTarget;
      content: ChannelOutbound;
      afterMessageId?: string;
      retryOf?: string;
    }
  | {
      phase: "result";
      result: ChannelDeliveryResult;
      notification?: DeliveryNotification;
    }
  | { phase: "notification"; notification: DeliveryNotification }
);
export type DeliveryDisplay = Extract<DeliveryRecord, { phase: "request" }> & {
  timestamp: number;
  result?: ChannelDeliveryResult;
  notification?: DeliveryNotification;
};
export const EMPTY_DELIVERIES: readonly DeliveryDisplay[] = [];

export const useDeliveryHistory = create<{
  pending: Record<string, boolean>;
  sessions: Record<string, readonly DeliveryDisplay[]>;
}>(() => ({ pending: {}, sessions: {} }));

export function projectDeliveries(
  records: readonly SessionMessage[],
): DeliveryDisplay[] {
  const entries = new Map<string, DeliveryDisplay>();
  for (const record of records) {
    if (record.role !== "delivery") continue;
    reduceDeliveryRecord(entries, record);
  }
  return [...entries.values()];
}

/** 通知处理不篡改投递事实；无终态的历史请求在发送结束后同样需要处理。 */
export function hasDeliveryIssue(
  entry: DeliveryDisplay,
  pending = false,
): boolean {
  return (
    !pending &&
    (entry.notification?.status === "error" ||
      (!entry.notification && !entry.result))
  );
}

/** 新请求与旧通知的重试关联在同一条记录中提交，避免保存一半导致旧问题丢失。 */
function reduceDeliveryRecord(
  entries: Map<string, DeliveryDisplay>,
  record: Extract<SessionMessage, { role: "delivery" }>,
): void {
  const item = record.content;
  if (item.phase === "request") {
    const previous = item.retryOf ? entries.get(item.retryOf) : undefined;
    if (previous)
      entries.set(previous.id, {
        ...previous,
        notification: { status: "retried", retryId: item.id },
      });
    entries.set(item.id, { ...item, timestamp: Date.parse(record.timestamp) });
    return;
  }
  const entry = entries.get(item.id);
  if (!entry) return;
  entries.set(
    item.id,
    item.phase === "result"
      ? {
          ...entry,
          result: item.result,
          notification:
            entry.notification?.status === "ignored" ||
            entry.notification?.status === "retried"
              ? entry.notification
              : item.notification,
        }
      : { ...entry, notification: item.notification },
  );
}

export function setDeliveryHistory(
  id: string,
  entries?: readonly DeliveryDisplay[],
) {
  useDeliveryHistory.setState((state) => {
    const sessions = { ...state.sessions };
    if (entries) sessions[id] = entries;
    else delete sessions[id];
    return { sessions };
  });
}

export function applyDeliveryRecord(
  id: string,
  record: Extract<SessionMessage, { role: "delivery" }>,
) {
  const entries = useDeliveryHistory.getState().sessions[id] ?? [];
  const next = new Map(entries.map((entry) => [entry.id, entry]));
  reduceDeliveryRecord(next, record);
  setDeliveryHistory(id, [...next.values()]);
}

/** 运行状态只留内存，重启后的无回执记录保持未确认。 */
export function setDeliveryPending(id: string, value: boolean) {
  useDeliveryHistory.setState((state) => {
    const pending = { ...state.pending };
    if (value) pending[id] = true;
    else delete pending[id];
    return { pending };
  });
}

/** 所有出口的投递展示事实；与 Agent 共用会话文件，但不构造模型消息。 */
import { create } from "zustand";
import type { SessionMessage } from "@/modules/ai/lib/conversation";
import type {
  ChannelTarget,
  ChannelOutbound,
  ChannelDeliveryResult,
  ChannelDeliverySource,
} from "@/modules/channels/types";

export type DeliveryRecord = { id: string } & (
  | {
      phase: "request";
      source?: ChannelDeliverySource;
      target: ChannelTarget;
      content: ChannelOutbound;
      afterMessageId?: string;
    }
  | { phase: "result"; result: ChannelDeliveryResult }
);
export type DeliveryDisplay = Extract<DeliveryRecord, { phase: "request" }> & {
  timestamp: number;
  result?: ChannelDeliveryResult;
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
    const item = record.content;
    if (item.phase === "request")
      entries.set(item.id, {
        ...item,
        timestamp: Date.parse(record.timestamp),
      });
    else {
      const entry = entries.get(item.id);
      if (entry) entry.result = item.result;
    }
  }
  return [...entries.values()];
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
  const item = record.content;
  setDeliveryHistory(
    id,
    item.phase === "request"
      ? [...entries, { ...item, timestamp: Date.parse(record.timestamp) }]
      : entries.map((entry) =>
          entry.id === item.id ? { ...entry, result: item.result } : entry,
        ),
  );
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

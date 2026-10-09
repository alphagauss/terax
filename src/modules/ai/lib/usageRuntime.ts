/** 会话拥有的用量记录。保存只确认已提交批次，恢复和 UI 读取同一份调用事实。 */
import type { SessionMessage } from "@/modules/ai/lib/conversation";
import type { UsageRecord } from "@/modules/ai/lib/usage";

const sessions = new Map<
  string,
  {
    records: readonly UsageRecord[];
    settled: readonly UsageRecord[];
    saved: number;
  }
>();
const listeners = new Map<string, Set<() => void>>();
const EMPTY: readonly UsageRecord[] = [];
function publish(id: string) {
  for (const listener of listeners.get(id) ?? []) listener();
}
export function usageRecords(
  id: string,
  settled = false,
): readonly UsageRecord[] {
  const state = sessions.get(id);
  return (settled ? state?.settled : state?.records) ?? EMPTY;
}
export function subscribeUsage(id: string, listener: () => void) {
  const group = listeners.get(id) ?? new Set();
  group.add(listener);
  listeners.set(id, group);
  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(id);
  };
}
export function recordUsage(id: string, record: UsageRecord) {
  const state = sessions.get(id) ?? {
    records: EMPTY,
    settled: EMPTY,
    saved: 0,
  };
  if (state.records.some((item) => item.callId === record.callId)) return;
  state.records = [...state.records, record];
  sessions.set(id, state);
  publish(id);
}
export function restoreUsage(id: string, messages: readonly SessionMessage[]) {
  const records = messages.flatMap((message): UsageRecord[] => {
    if (message.role !== "usage") return [];
    return [{ ...message.content, callId: message.call_id }];
  });
  const unique = [
    ...new Map(records.map((record) => [record.callId, record])).values(),
  ];
  sessions.set(id, { records: unique, settled: unique, saved: unique.length });
  publish(id);
}
export function pendingUsage(id: string, timestamp: string): SessionMessage[] {
  const state = sessions.get(id);
  return (state?.records.slice(state.saved) ?? []).map(
    ({ callId, ...content }) => ({
      role: "usage",
      call_id: callId,
      content,
      turn_id: content.turnId,
      timestamp,
    }),
  );
}
export function acknowledgeUsage(id: string, count: number) {
  const state = sessions.get(id);
  if (state) state.saved += count;
}
export function releaseUsage(id: string) {
  sessions.delete(id);
  publish(id);
}

/** 轮末原子提交成功后更新已结算快照，供最终回答的统计入口读取。 */
export function settleUsage(id: string) {
  const state = sessions.get(id);
  if (state) {
    state.settled = state.records;
    publish(id);
  }
}

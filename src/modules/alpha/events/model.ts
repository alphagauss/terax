/**
 * 本文件定义 Alpha 公共事件客户端的稳定选择器和 envelope。
 * 事件只用于变化通知，权威任务、行情和交易状态仍由对应 HTTP 查询恢复。
 */

export const ALPHA_EVENT_TYPES = [
  "task.updated",
  "market.bar",
  "market.status",
  "order.updated",
  "trade.created",
  "position.updated",
  "account.updated",
  "strategy.signal",
  "alert.triggered",
  "risk.triggered",
  "notification.created",
] as const;

export type AlphaEventType = (typeof ALPHA_EVENT_TYPES)[number];

export type AlphaEventSelector = {
  event: AlphaEventType;
  key: string | null;
};

export type AlphaEventEnvelope = {
  event: AlphaEventType;
  key: string | null;
  revision: number | null;
  time: string;
  data: unknown;
};

export type AlphaEventConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

/** 返回远程订阅和本地引用计数共用的稳定 selector ID。 */
export function alphaEventSelectorId(selector: AlphaEventSelector): string {
  return JSON.stringify([selector.event, selector.key]);
}

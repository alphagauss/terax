/**
 * 本文件根据窗口状态选择 Agent 通知的投递渠道。
 * 这里只返回策略，不触发系统 API、应用内提示或通知存储。
 */

export type AgentNotificationDelivery = "none" | "native" | "toast" | "bell";

/** 根据焦点、可见性与提示许可选择唯一的通知渠道。 */
export function resolveAgentNotificationDelivery({
  focused,
  visible,
  allowToast,
}: {
  focused: boolean;
  visible: boolean;
  allowToast: boolean;
}): AgentNotificationDelivery {
  if (focused && visible) return "none";
  if (!focused) return "native";
  return allowToast ? "toast" : "bell";
}

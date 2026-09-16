/**
 * 本文件根据窗口焦点和用户偏好路由 Agent 通知。
 * 通知只保存可导航的下游身份，并在投递前抑制同一目标的短时重复事件。
 */

import { usePreferencesStore } from "@/modules/settings/preferences";
import { showAgentToast } from "../components/AgentToast";
import { useAgentStore } from "../store/agentStore";
import { resolveAgentNotificationDelivery } from "./delivery";
import { createAgentNotificationGate } from "./notificationGate";
import { osNotify } from "@/modules/notifications/client";
import type { AgentSource, NotificationKind } from "./types";

const shouldDeliver = createAgentNotificationGate();

type RouteArgs = {
  source: AgentSource;
  agent: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  focused: boolean;
  /** True when the user is currently looking at this agent. */
  visible: boolean;
  /** Allow an in-app toast when focused but not looking at the agent. */
  allowToast: boolean;
  tabId?: number;
  sessionId?: string;
  onActivate: () => void;
};

/** 根据窗口可见性与用户偏好选择通知栏、系统通知或应用内提示。 */
export function routeAgentNotification({
  source,
  agent,
  kind,
  title,
  body,
  focused,
  visible,
  allowToast,
  tabId = 0,
  sessionId,
  onActivate,
}: RouteArgs): void {
  const delivery = resolveAgentNotificationDelivery({
    focused,
    visible,
    allowToast,
  });
  if (delivery === "none") return;
  if (!shouldDeliver({ source, agent, kind, tabId, sessionId })) return;

  useAgentStore
    .getState()
    .pushNotification({ source, agent, kind, tabId, sessionId });

  // 总开关只控制主动提醒，铃铛记录仍供用户主动查看。
  if (!usePreferencesStore.getState().agentNotifications) return;

  if (delivery === "native") {
    void osNotify(title, body ?? agent, {
      window: "main",
      target:
        source === "terminal"
          ? { module: "terminal", tabId }
          : sessionId
            ? { module: "ai", sessionId }
            : { module: "workspace" },
    });
    return;
  }
  if (delivery === "toast") {
    showAgentToast({
      agent,
      title,
      body,
      onActivate: () => {
        useAgentStore
          .getState()
          .dismissNotificationsForTarget({ source, tabId, sessionId });
        onActivate();
      },
    });
  }
}

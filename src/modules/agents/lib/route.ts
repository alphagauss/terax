/**
 * 本文件根据窗口焦点和用户偏好路由 Agent 通知。
 * 通知只保存可直接导航的标签 ID，不复制终端身份。
 */

import { usePreferencesStore } from "@/modules/settings/preferences";
import { showAgentToast } from "../components/AgentToast";
import { useAgentStore } from "../store/agentStore";
import { osNotify } from "./notify";
import type { AgentSource, NotificationKind } from "./types";

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
  onActivate,
}: RouteArgs): void {
  if (!usePreferencesStore.getState().agentNotifications) return;
  if (focused && visible) return;

  useAgentStore.getState().pushNotification({ source, agent, kind, tabId });

  if (!focused) {
    void osNotify(title, body ?? agent);
    return;
  }
  if (allowToast) {
    showAgentToast({ agent, title, body, onActivate });
  }
}

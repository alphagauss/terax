/**
 * 本文件把原生 PTY Agent 信号桥接到标签状态和通知系统。
 * PTY ID 先映射到终端标签 ID，后续状态只使用标签的唯一身份。
 */

import i18n from "@/i18n";
import { terminalIdForPty } from "@/modules/terminal";
import type { Tab } from "@/modules/workbench";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { displayAgent } from "../lib/format";
import { maybeTriggerManagedReview } from "../lib/review";
import { routeAgentNotification } from "../lib/route";
import type { AgentSession, AgentSignal } from "../lib/types";
import { useWindowFocus } from "../lib/useWindowFocus";
import { useAgentStore } from "../store/agentStore";
import { useManagedAgentsStore } from "../store/managedAgentsStore";

type Activate = (tabId: number) => void;
type Ctx = {
  tabs: Tab[];
  activeId: number;
  focused: boolean;
  onActivate: Activate;
};

function findTerminalTab(tabs: Tab[], tabId: number) {
  const tab = tabs.find((candidate) => candidate.id === tabId);
  return tab?.kind === "terminal" ? tab : null;
}

function route(
  session: AgentSession,
  kind: "attention" | "finished",
  ctx: Ctx,
): void {
  const tab = findTerminalTab(ctx.tabs, session.tabId);
  const name = displayAgent(session.agent);
  const heading =
    kind === "attention"
      ? i18n.t("agents:signal.needsInput", { name })
      : i18n.t("agents:signal.finished", { name });

  routeAgentNotification({
    source: "terminal",
    agent: session.agent,
    kind,
    title: heading,
    body: tab?.title,
    focused: ctx.focused,
    visible: ctx.activeId === session.tabId,
    // Stop fires every turn, so finished only updates the bell; attention toasts.
    allowToast: kind === "attention",
    tabId: session.tabId,
    onActivate: () => ctx.onActivate(session.tabId),
  });
}

function handleSignal(sig: AgentSignal, ctx: Ctx): void {
  const tabId = terminalIdForPty(sig.id);
  if (tabId === null) return;
  const store = useAgentStore.getState();

  switch (sig.kind) {
    case "started": {
      if (!findTerminalTab(ctx.tabs, tabId)) return;
      store.start(tabId, sig.agent ?? "agent");
      return;
    }
    case "working":
      store.setStatus(tabId, "working");
      return;
    case "attention": {
      store.setStatus(tabId, "waiting");
      const session = store.sessions[tabId];
      if (session) route(session, "attention", ctx);
      return;
    }
    case "finished": {
      store.setStatus(tabId, "waiting");
      const session = store.sessions[tabId];
      if (session) route(session, "finished", ctx);
      maybeTriggerManagedReview(tabId);
      return;
    }
    case "exited":
      store.finish(tabId);
      useManagedAgentsStore.getState().remove(tabId);
      return;
  }
}

/** 监听 Agent 生命周期信号并更新对应标签的通知状态。 */
export function AgentNotificationsBridge({
  tabs,
  activeId,
  onActivate,
}: {
  tabs: Tab[];
  activeId: number;
  onActivate: Activate;
}) {
  const focused = useWindowFocus();
  const ctxRef = useRef<Ctx>({ tabs, activeId, focused, onActivate });
  ctxRef.current = { tabs, activeId, focused, onActivate };

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<AgentSignal>("terax:agent-signal", (e) =>
      handleSignal(e.payload, ctxRef.current),
    )
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return null;
}

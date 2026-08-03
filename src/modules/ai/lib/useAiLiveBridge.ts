/**
 * 本文件把当前 Workbench 的实时上下文桥接到 AI 会话。
 * Agent 终端按需初始化 Workspace 环境，敏感终端内容不会进入 AI 上下文。
 */

import { useManagedAgentsStore } from "@/modules/agents/store/managedAgentsStore";
import {
  type TerminalPaneHandle,
  whenSessionReady,
  writeToSession,
} from "@/modules/terminal";
import type { Tab } from "@/modules/workbench";
import { invoke } from "@tauri-apps/api/core";
import { type RefObject, useEffect, useRef } from "react";
import type { Live } from "../store/chatStore";
import { redactSensitive } from "./redact";

type TuiWaitResult = "ready" | "gone" | "timeout";

async function waitForClaudeTuiReady(
  readBuf: () => string | null,
  timeoutMs = 8000,
): Promise<TuiWaitResult> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const buf = readBuf();
    if (buf === null) return "gone";
    if (buf.includes("shortcuts") || buf.includes("? for")) return "ready";
    await new Promise((r) => setTimeout(r, 120));
  }
  return "timeout";
}

type Params = {
  setLive: (live: Live) => void;
  activeId: number;
  tabs: Tab[];
  explorerRoot: string | null;
  launchCwd: string | null;
  home: string | null;
  openWebPreviewTab: (url: string) => void;
  newAgentTab: (cwd: string | undefined, title: string) => number;
  ensureWorkspaceReady: () => Promise<string | null>;
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
};

/**
 * 将 cwd、终端缓冲区、活动文件和 Agent 启动能力发布到聊天运行时。
 * live getter 通过 ref 读取最新状态，避免终端 OSC cwd 更新反复重建桥接对象。
 */
export function useAiLiveBridge(params: Params) {
  const { setLive, terminalRefs } = params;
  const ref = useRef(params);
  ref.current = params;

  useEffect(() => {
    const findCwd = () => {
      const { activeId, tabs, explorerRoot, launchCwd, home } = ref.current;
      const active = tabs.find((x) => x.id === activeId);
      if (active?.kind === "terminal") {
        return active.cwd ?? null;
      }
      for (let i = tabs.length - 1; i >= 0; i--) {
        const t = tabs[i];
        if (t.kind !== "terminal") continue;
        if (t.cwd) return t.cwd;
      }
      return explorerRoot ?? launchCwd ?? home ?? null;
    };

    setLive({
      getCwd: findCwd,
      getTerminalContext: () => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        if (t?.kind !== "terminal") return null;
        if (t.private) return null;
        const buf = terminalRefs.current.get(t.id)?.getBuffer(300);
        return buf ? redactSensitive(buf) : null;
      },
      isActiveTerminalPrivate: () => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "terminal" && t.private === true;
      },
      injectIntoActivePty: (text) => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        if (t?.kind !== "terminal") return false;
        const term = terminalRefs.current.get(t.id);
        if (!term) return false;
        term.write(text);
        term.focus();
        return true;
      },
      getWorkspaceRoot: () => {
        const { explorerRoot, launchCwd, home } = ref.current;
        return explorerRoot ?? launchCwd ?? home ?? null;
      },
      getActiveFile: () => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "editor" ? t.path : null;
      },
      openWebPreview: (url: string) => {
        ref.current.openWebPreviewTab(url);
        return true;
      },
      spawnManagedAgent: async (prompt: string, sessionId: string) => {
        const trimmed = prompt.trim();
        if (!trimmed) return null;
        const readyHome = await ref.current.ensureWorkspaceReady();
        if (!readyHome) return null;
        const oneLine = trimmed.replace(/\s*\r?\n\s*/g, " ");
        const cwd = findCwd() ?? readyHome;
        const short =
          oneLine.length > 32 ? `${oneLine.slice(0, 32)}…` : oneLine;
        const tabId = ref.current.newAgentTab(cwd, `claude · ${short}`);
        useManagedAgentsStore
          .getState()
          .register({ tabId, sessionId, task: oneLine, cwd });
        const hooksReady = invoke("agent_enable_hooks", {
          agent: "claude",
        }).catch(() => {});
        void (async () => {
          await Promise.all([whenSessionReady(tabId), hooksReady]);
          if (!writeToSession(tabId, "claude\r")) {
            useManagedAgentsStore.getState().remove(tabId);
            return;
          }
          const readBuf = () => {
            const term = terminalRefs.current.get(tabId);
            return term ? term.getBuffer(120) : null;
          };
          const result = await waitForClaudeTuiReady(readBuf);
          if (result !== "ready") {
            if (result === "timeout") {
              console.warn(
                "[terax] Claude TUI did not appear in time; aborting prompt send",
              );
            }
            useManagedAgentsStore.getState().remove(tabId);
            return;
          }
          if (!writeToSession(tabId, `\x1b[200~${trimmed}\x1b[201~`)) {
            useManagedAgentsStore.getState().remove(tabId);
            return;
          }
          setTimeout(() => writeToSession(tabId, "\r"), 120);
          useManagedAgentsStore.getState().setPhase(tabId, "working");
        })();
        return tabId;
      },
      readTerminalBuffer: (tabId: number) => {
        const buf = terminalRefs.current.get(tabId)?.getBuffer(300);
        return buf ? redactSensitive(buf) : null;
      },
    });
  }, [setLive, terminalRefs]);
}

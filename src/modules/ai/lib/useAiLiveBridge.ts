/**
 * 本文件把当前 Workbench 的实时上下文和导航能力桥接到 AI 会话。
 * 历史会话目录导航复用现有标签，并在新建终端前校验和授权目录。
 */

import { currentWorkspaceEnv } from "@/modules/workspace";
import type { TerminalPaneHandle } from "@/modules/terminal";
import type { Tab } from "@/modules/workbench";
import { invoke } from "@tauri-apps/api/core";
import { type RefObject, useEffect, useRef } from "react";
import type { Live } from "../store/chatStore";
import { native } from "./native";
import { redactSensitive } from "./redact";
import { resolveWorkingDirectoryTarget } from "./workingDirectoryNavigation";

type Params = {
  setLive: (live: Live) => void;
  activeId: number;
  activeSpaceId: string | null;
  tabs: Tab[];
  explorerRoot: string | null;
  setActiveId: (tabId: number) => void;
  newTab: (cwd?: string) => number;
  ensureWorkspaceReady: () => Promise<string | null>;
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
};

/**
 * 将 Explorer 根目录、目录导航和终端缓冲区发布到聊天运行时。
 * 终端 getter 通过 ref 读取最新状态，避免终端更新反复重建桥接对象。
 */
export function useAiLiveBridge(params: Params) {
  const { setLive, terminalRefs } = params;
  const ref = useRef(params);
  ref.current = params;

  useEffect(() => {
    setLive({
      explorerRoot: params.explorerRoot,
      revealWorkingDirectory: async (cwd: string) => {
        const decide = (path: string) => {
          const current = ref.current;
          return resolveWorkingDirectoryTarget(
            current.tabs,
            current.explorerRoot,
            path,
            currentWorkspaceEnv(),
            current.activeSpaceId,
          );
        };
        const applyExisting = (path: string) => {
          const target = decide(path);
          if (target.kind === "tab") {
            ref.current.setActiveId(target.tabId);
          }
          return target.kind !== "new-terminal";
        };

        if (applyExisting(cwd)) return;
        if (!(await ref.current.ensureWorkspaceReady())) return;
        if (applyExisting(cwd)) return;

        const workspace = currentWorkspaceEnv();
        const stat = await invoke<{ kind: string }>("fs_stat", {
          path: cwd,
          workspace,
        });
        if (stat.kind !== "dir") throw new Error("cwd is not a directory");
        const authorized = await native.workspaceAuthorize(cwd);
        const terminalCwd = workspace.kind === "wsl" ? cwd : authorized;

        if (applyExisting(cwd) || applyExisting(terminalCwd)) return;
        ref.current.newTab(terminalCwd);
      },
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
    });
  }, [params.explorerRoot, setLive, terminalRefs]);
}

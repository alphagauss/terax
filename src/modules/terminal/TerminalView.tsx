/**
 * 本文件把 Workbench 终端标签连接到终端视图和文件拖放反馈。
 * 标签 ID 直接作为前端终端运行时的唯一身份。
 */

import { useTerminalDropStore } from "@/modules/terminal/lib/dropStore";
import {
  TerminalPane,
  type TerminalPaneHandle,
} from "@/modules/terminal/TerminalPane";
import type { TerminalTab } from "@/modules/workbench";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  tab: TerminalTab;
  visible: boolean;
  focused: boolean;
  registerHandle: (
    terminalId: number,
    handle: TerminalPaneHandle | null,
  ) => void;
  onCwd: (terminalId: number, cwd: string) => void;
  onExit: (terminalId: number, code: number) => void;
};

/** 渲染终端标签，并用标签 ID 注册对应终端句柄。 */
export function TerminalView({
  tab,
  visible,
  focused,
  registerHandle,
  onCwd,
  onExit,
}: Props) {
  const setRef = useCallback(
    (handle: TerminalPaneHandle | null) => registerHandle(tab.id, handle),
    [registerHandle, tab.id],
  );
  return (
    <div data-terminal-id={tab.id} className="relative h-full w-full">
      <TerminalPane
        ref={setRef}
        terminalId={tab.id}
        visible={visible}
        focused={focused}
        initialCwd={tab.cwd}
        blocks={tab.blocks}
        onCwd={onCwd}
        onExit={onExit}
      />
      <TerminalDropOverlay terminalId={tab.id} />
    </div>
  );
}

function TerminalDropOverlay({ terminalId }: { terminalId: number }) {
  const { t } = useTranslation("terminal");
  const active = useTerminalDropStore(
    (state) => state.targetTerminalId === terminalId,
  );
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-2 grid place-items-center rounded-lg border border-primary/45 bg-background/70 text-xs font-medium text-foreground shadow-lg backdrop-blur-sm">
      {t("dropFilePathHere")}
    </div>
  );
}

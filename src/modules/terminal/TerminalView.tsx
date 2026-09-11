/**
 * 本文件把 Workbench 终端标签连接到终端视图并注册对应句柄。
 * 标签 ID 直接作为前端终端运行时的唯一身份。
 */

import {
  TerminalPane,
  type TerminalPaneHandle,
} from "@/modules/terminal/TerminalPane";
import type { TerminalTab } from "@/modules/workbench";
import { useCallback } from "react";

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
    <div className="relative h-full w-full">
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
    </div>
  );
}

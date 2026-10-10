/**
 * 本文件把块终端状态封装为工作区输入栏使用的控制器。
 * 控制器只操作当前终端 ID，不持有 Workbench 布局状态。
 */

import { useEffect, useMemo, useState } from "react";
import type { BlockMode } from "../block/lib/modeMachine";
import {
  getTerminalBlockMode,
  interruptTerminal,
  terminalCwd,
  submitToTerminal,
  subscribeTerminalBlockMode,
} from "./useTerminalSession";

export type BlockController = {
  blockMode: BlockMode;
  submitCommand: (text: string) => Promise<boolean>;
  interrupt: () => void;
  getCwd: () => string | null;
};

/** 将指定终端的块模式、提交、中断和 cwd 能力组合成输入栏控制器。 */
export function useBlockController(
  terminalId: number | null,
): BlockController | null {
  const [blockMode, setBlockMode] = useState<BlockMode>("prompt");

  useEffect(() => {
    if (terminalId == null) return;
    setBlockMode(getTerminalBlockMode(terminalId));
    return subscribeTerminalBlockMode(terminalId, () =>
      setBlockMode(getTerminalBlockMode(terminalId)),
    );
  }, [terminalId]);

  return useMemo(() => {
    if (terminalId == null) return null;
    return {
      blockMode,
      submitCommand: (text) => submitToTerminal(terminalId, text),
      interrupt: () => interruptTerminal(terminalId),
      getCwd: () => terminalCwd(terminalId),
    };
  }, [terminalId, blockMode]);
}

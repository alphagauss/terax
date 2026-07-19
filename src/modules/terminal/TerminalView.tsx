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

export function TerminalView({
  tab,
  visible,
  focused,
  registerHandle,
  onCwd,
  onExit,
}: Props) {
  const setRef = useCallback(
    (handle: TerminalPaneHandle | null) =>
      registerHandle(tab.terminalId, handle),
    [registerHandle, tab.terminalId],
  );
  return (
    <div data-terminal-id={tab.terminalId} className="relative h-full w-full">
      <TerminalPane
        ref={setRef}
        leafId={tab.terminalId}
        visible={visible}
        focused={focused}
        initialCwd={tab.cwd}
        blocks={tab.blocks}
        onCwd={onCwd}
        onExit={onExit}
      />
      <TerminalDropOverlay terminalId={tab.terminalId} />
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

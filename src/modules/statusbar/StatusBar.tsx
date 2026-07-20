import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AgentStatusPill } from "@/modules/ai/components/AgentStatusPill";
import { LspStatusPill } from "@/modules/lsp";
import { TunnelStatusControl } from "@/modules/remote";
import type { WorkspaceEnv } from "@/modules/workspace";
import { IncognitoIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslation } from "react-i18next";
import { CwdBreadcrumb } from "./CwdBreadcrumb";
import { DiagnosticsBadge } from "./DiagnosticsBadge";
import { WorkspaceEnvSelector } from "./WorkspaceEnvSelector";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  workspaceError: string | null;
  onWorkspaceRetry: () => Promise<string | null>;
  onCd: (path: string) => void;
  onWorkspaceChange: (env: WorkspaceEnv) => void;
  onToggleAi: () => void;
  aiOpen: boolean;
  privateActive: boolean;
};

export function StatusBar({
  cwd,
  filePath,
  home,
  workspaceError,
  onWorkspaceRetry,
  onCd,
  onWorkspaceChange,
  onToggleAi,
  aiOpen,
  privateActive,
}: Props) {
  const { t } = useTranslation("statusbar");
  return (
    <footer className="flex h-6 shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-card/60 pl-3 pr-4 text-[11px]">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <WorkspaceEnvSelector
          onSelect={onWorkspaceChange}
          connectionError={workspaceError}
          onCurrentConnected={onWorkspaceRetry}
        />
        <CwdBreadcrumb cwd={cwd} filePath={filePath} home={home} onCd={onCd} />
        <LspStatusPill filePath={filePath ?? null} />
        <DiagnosticsBadge filePath={filePath ?? null} />
        {privateActive ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex shrink-0 cursor-default items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
                <HugeiconsIcon icon={IncognitoIcon} size={11} strokeWidth={2} />
                <span>{t("private.label")}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-64 text-[11px] leading-relaxed"
            >
              {t("private.tooltip")}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <TunnelStatusControl />
        <AgentStatusPill onClick={onToggleAi} active={aiOpen} />
      </div>
    </footer>
  );
}

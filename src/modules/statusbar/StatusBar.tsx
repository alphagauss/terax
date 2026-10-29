/**
 * 本文件实现应用底部状态栏。
 * 负责组合工作区、诊断、Python、隐私、后台传输、SSH RTT、能力与流量、隧道和 Agent 状态，不持有各子系统业务状态。
 */

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/controls/tooltip";
import { AgentStatusPill } from "@/modules/ai/components/AgentStatusPill";
import { LspStatusPill } from "@/modules/lsp";
import type { PythonInterpreter } from "@/modules/python/native";
import {
  SshCapabilityControl,
  SshRttIndicator,
  SshTrafficControl,
  TunnelStatusControl,
} from "@/modules/remote";
import { TransferStatusControl } from "@/modules/transfers";
import type { WorkspaceEnv } from "@/modules/workspace";
import IncognitoIcon from "@hugeicons/core-free-icons/IncognitoIcon";
import SourceCodeIcon from "@hugeicons/core-free-icons/SourceCodeIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslation } from "react-i18next";
import { ActivePath } from "./ActivePath";
import { DiagnosticsBadge } from "./DiagnosticsBadge";
import { WorkspaceEnvSelector } from "./WorkspaceEnvSelector";
import "./status-bar.css";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  workspaceError: string | null;
  onWorkspaceRetry: () => Promise<string | null>;
  onWorkspaceReconnect: () => void;
  onWorkspaceChange: (env: WorkspaceEnv) => void;
  onToggleAi: () => void;
  aiOpen: boolean;
  privateActive: boolean;
  pythonFileActive: boolean;
  pythonInterpreter: PythonInterpreter | null;
  onSelectPython: () => void;
};

/** 组合应用级状态、后台任务入口与活动工作页路径。 */
export function StatusBar({
  cwd,
  filePath,
  workspaceError,
  onWorkspaceRetry,
  onWorkspaceReconnect,
  onWorkspaceChange,
  onToggleAi,
  aiOpen,
  privateActive,
  pythonFileActive,
  pythonInterpreter,
  onSelectPython,
}: Props) {
  const { t } = useTranslation("statusbar");
  return (
    <footer className="app-status-bar border-t border-layout-divider bg-sidebar dark:bg-card/60">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <WorkspaceEnvSelector
          onSelect={onWorkspaceChange}
          connectionError={workspaceError}
          onCurrentConnected={onWorkspaceRetry}
          onCurrentReconnect={onWorkspaceReconnect}
        />
        <SshRttIndicator />
        <SshCapabilityControl />
        <ActivePath path={filePath ?? cwd} file={Boolean(filePath)} />
        <LspStatusPill filePath={filePath ?? null} />
        <DiagnosticsBadge filePath={filePath ?? null} />
        {privateActive ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="status-bar-item status-bar-badge cursor-default bg-warning/15 font-medium text-warning">
                <HugeiconsIcon icon={IncognitoIcon} strokeWidth={2} />
                <span className="truncate">{t("private.label")}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-64 leading-relaxed">
              {t("private.tooltip")}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {pythonFileActive ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="status-bar-item min-w-0 max-w-44 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={onSelectPython}
              >
                <HugeiconsIcon icon={SourceCodeIcon} strokeWidth={2} />
                <span className="truncate">
                  {pythonInterpreter
                    ? pythonInterpreter.kind === "system"
                      ? pythonInterpreter.name
                      : `${pythonInterpreter.name} (${pythonInterpreter.version})`
                    : t("python.select")}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-80">
              {pythonInterpreter
                ? t("python.selected", { path: pythonInterpreter.path })
                : t("python.unselected")}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <TransferStatusControl />
        <SshTrafficControl />
        <TunnelStatusControl />
        <AgentStatusPill onClick={onToggleAi} active={aiOpen} />
      </div>
    </footer>
  );
}

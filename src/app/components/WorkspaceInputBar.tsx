import { Chip } from "@/modules/ai/components/Chip";
import { useBlockController } from "@/modules/terminal/lib/blockController";
import { useTheme } from "@/modules/theme";
import {
  CommandLineIcon,
  Folder01Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { OsIcon } from "./OsIcon";
import { useGitBranch } from "./useGitBranch";
import { useSystemInfo } from "./useSystemInfo";

const ShellInput = lazy(() => import("@/modules/terminal/block/ShellInput"));

type Props = {
  isBlockTab: boolean;
  isTerminalTab: boolean;
  activeLeafId: number | null;
  cwd: string | null;
  home: string | null;
};

export function WorkspaceInputBar({
  isBlockTab,
  isTerminalTab,
  activeLeafId,
  cwd,
  home,
}: Props) {
  const { resolvedMode, themeId, customThemes } = useTheme();
  const themeKey = `${resolvedMode}:${themeId}:${customThemes.length}`;
  const { os, shell } = useSystemInfo();
  const controller = useBlockController(isBlockTab ? activeLeafId : null);
  const blockMode = controller?.blockMode ?? "prompt";

  const [promptNonce, setPromptNonce] = useState(0);
  const prevBlockMode = useRef(blockMode);
  useEffect(() => {
    if (prevBlockMode.current !== "prompt" && blockMode === "prompt") {
      setPromptNonce((nonce) => nonce + 1);
    }
    prevBlockMode.current = blockMode;
  }, [blockMode]);
  const branch = useGitBranch(isTerminalTab ? cwd : null, promptNonce);

  if (!isBlockTab || !controller || activeLeafId === null) return null;

  return (
    <div className="shrink-0 border-t border-border/60 bg-card/40 px-3 py-2">
      <div className="flex flex-col gap-2 rounded-lg px-1 py-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {os ? (
            <Chip tone="neutral" iconNode={<OsIcon os={os} />} title={os} />
          ) : null}
          {cwd ? (
            <Chip tone="blue" icon={Folder01Icon} title={cwd}>
              {relPath(cwd, home)}
            </Chip>
          ) : null}
          {branch ? (
            <Chip
              tone="violet"
              icon={GitBranchIcon}
              title={`Branch: ${branch}`}
            >
              {branch}
            </Chip>
          ) : null}
          {shell ? (
            <Chip tone="emerald" icon={CommandLineIcon}>
              {shell}
            </Chip>
          ) : null}
        </div>
        <Suspense fallback={null}>
          <ShellInput
            leafId={activeLeafId}
            mode={blockMode}
            focused
            themeKey={themeKey}
            onSubmit={controller.submitCommand}
            onInterrupt={controller.interrupt}
            getCwd={controller.getCwd}
          />
        </Suspense>
      </div>
    </div>
  );
}

function relPath(path: string, home: string | null): string {
  if (!home) return path;
  const normalizedHome = home.replace(/\/+$/, "");
  if (path === normalizedHome || path.startsWith(`${normalizedHome}/`)) {
    return `~${path.slice(normalizedHome.length)}`;
  }
  return path;
}

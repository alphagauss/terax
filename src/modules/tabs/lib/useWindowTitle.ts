import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { findLeafCwd } from "@/modules/terminal/lib/panes";
import type { Tab } from "./useTabs";
import { currentWorkspaceBootstrap } from "@/modules/workspace-process";

const APP_NAME = "Terax";

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "/";
}

/** Label of the focused tab — for terminals, the active pane's folder. */
function tabLabel(tab: Tab | undefined): string {
  if (!tab) return "";
  if (tab.kind === "terminal") {
    const cwd = findLeafCwd(tab.paneTree, tab.activeLeafId) ?? tab.cwd;
    return cwd ? basename(cwd) : tab.title;
  }
  return tab.title;
}

/**
 * Drives the OS window title from the focused tab + project folder, the way
 * Spotify shows the current track instead of just the app name. Without this
 * the window keeps the build-time default ("Tauri App" on Linux).
 *
 * Format: `<project> — <tab>` (e.g. `terax-ai — src`), collapsing to just the
 * project when the focused terminal sits at the project root. Falls back to the
 * app name when there's nothing to show.
 */
export function useWindowTitle(
  activeTab: Tab | undefined,
  explorerRoot: string | null,
): void {
  const project = explorerRoot ? basename(explorerRoot) : "";
  const label = tabLabel(activeTab);

  useEffect(() => {
    const bootstrap = currentWorkspaceBootstrap();
    const environment =
      bootstrap.env.kind === "wsl"
        ? `WSL ${bootstrap.env.distro}`
        : bootstrap.env.kind === "ssh"
          ? `SSH ${bootstrap.env.profileId}`
          : "Local";
    let content: string;
    if (project && label && label !== project) content = `${project} — ${label}`;
    else content = project || label || APP_NAME;
    const title = `${content} · ${environment} · ${bootstrap.id.slice(0, 8)}`;

    document.title = title;
    void getCurrentWindow()
      .setTitle(title)
      .catch(() => {});
  }, [project, label]);
}

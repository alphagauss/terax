/**
 * 本文件根据当前 Workspace 环境和激活页同步原生窗口标题。
 * 主窗口隐藏内部身份，临时窗口只显示便于区分的短 ID。
 */

import { useRemoteStore, type SshProfile } from "@/modules/remote";
import {
  currentWorkspaceBootstrap,
  type WorkspaceBootstrap,
} from "@/modules/workspace-process";
import type { Tab } from "@/modules/workbench";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

type WindowTitleLabels = {
  local: string;
  temporary: (id: string) => string;
};

/** 将 SSH 配置转换为标题使用的 endpoint，默认端口 22 不重复展示。 */
function sshEndpoint(profile: SshProfile | undefined): string | null {
  if (!profile) return null;
  const port = profile.port === 22 ? "" : `:${profile.port}`;
  return `${profile.username}@${profile.host}${port}`;
}

/** 根据环境、窗口类型和激活页生成不暴露内部 profile ID 的窗口标题。 */
export function formatWindowTitle(
  bootstrap: Pick<WorkspaceBootstrap, "env" | "id" | "isPrimary">,
  activeTabTitle: string | undefined,
  sshProfile: SshProfile | undefined,
  labels: WindowTitleLabels,
): string {
  const endpoint = sshEndpoint(sshProfile);
  const environment =
    bootstrap.env.kind === "wsl"
      ? `WSL ${bootstrap.env.distro}`
      : bootstrap.env.kind === "ssh"
        ? `SSH${endpoint ? ` ${endpoint}` : ""}`
        : labels.local;
  const parts = [environment];

  if (!bootstrap.isPrimary) {
    parts.push(labels.temporary(bootstrap.id.slice(0, 8)));
  }
  if (activeTabTitle?.trim()) parts.push(activeTabTitle.trim());

  return parts.join(" · ");
}

/** 在环境、窗口身份或激活页变化时同步浏览器和原生窗口标题。 */
export function useWindowTitle(activeTab: Tab | undefined): void {
  const { t } = useTranslation("tabs");
  const bootstrap = currentWorkspaceBootstrap();
  const env = bootstrap.env;
  const profiles = useRemoteStore((state) => state.profiles);
  const loadProfiles = useRemoteStore((state) => state.load);
  const sshProfile =
    env.kind === "ssh"
      ? profiles.find((profile) => profile.id === env.profileId)
      : undefined;

  useEffect(() => {
    if (env.kind === "ssh") void loadProfiles();
  }, [env.kind, loadProfiles]);

  useEffect(() => {
    const title = formatWindowTitle(bootstrap, activeTab?.title, sshProfile, {
      local: t("windowTitle.local"),
      temporary: (id) => t("windowTitle.temporary", { id }),
    });

    document.title = title;
    void getCurrentWindow()
      .setTitle(title)
      .catch(() => {});
  }, [activeTab?.title, bootstrap, sshProfile, t]);
}

/** Graph 与文件时间线共用的提交详情，统一文件列表、重试、复制和远端链接入口。 */

import {
  useViewActive,
  useViewState,
  readViewResource,
} from "@/modules/view-state";
import {
  type GitCommitFileChange,
  type GitLogEntry,
  native,
} from "@/modules/ai/lib/native";
import { CommitDetail } from "@/modules/git-history/CommitDetail";
import { CommitHoverCard } from "@/modules/git-history/CommitGraphInteraction";
import {
  commitWebUrl,
  hostLabel,
  parseRemoteWebUrl,
  type RemoteWebInfo,
} from "@/modules/git-history/lib/remoteWebUrl";
import type { useCommitGraph } from "@/modules/git-history/useCommitGraph";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

/** 展示现有 Git 历史详情；宿主保留选中文件及撤销操作的状态归属。 */
export function CommitHistoryHoverCard({
  repoRoot,
  commit,
  graph,
  onOpenFile,
  onUndo,
}: {
  repoRoot: string;
  commit: GitLogEntry | null;
  graph: ReturnType<typeof useCommitGraph>;
  onOpenFile: (file: GitCommitFileChange) => void;
  onUndo?: () => void;
}) {
  const { t } = useTranslation("gitHistory");
  const active = useViewActive(!!commit);
  const [remoteWeb, setRemoteWeb] = useViewState<RemoteWebInfo | null>(
    `remoteWeb:${repoRoot}`,
    null,
  );
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void readViewResource(`git-remote-url:${repoRoot}`, () =>
      native.gitRemoteUrl(repoRoot),
    )
      .then((url) => {
        if (!cancelled) setRemoteWeb(parseRemoteWebUrl(url));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, repoRoot]);

  return (
    <CommitHoverCard graph={graph} side="right">
      {commit ? (
        <CommitDetail
          key={commit.sha}
          commit={commit}
          filesEntry={graph.files.get(commit.sha) ?? null}
          remoteAction={
            remoteWeb
              ? {
                  label: t("viewOn", { host: hostLabel(remoteWeb) }),
                  onClick: () =>
                    void openUrl(commitWebUrl(remoteWeb, commit.sha)).catch(
                      console.error,
                    ),
                }
              : undefined
          }
          onUndo={onUndo}
          onRetry={() => void graph.fetchFiles(commit.sha, true)}
          onOpenFile={(file) => {
            onOpenFile(file);
            graph.close();
          }}
        />
      ) : null}
    </CommitHoverCard>
  );
}

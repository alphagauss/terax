/** 提交图谱的详情缓存、展开行和悬停生命周期。 */

import {
  useViewActive,
  useViewState,
  useViewScopeKey,
  readViewResource,
} from "@/modules/view-state";
import {
  TOOLTIP_DELAY_MS,
  TOOLTIP_SKIP_DELAY_MS,
} from "@/components/controls/tooltip";
import {
  type GitCommitFileChange,
  type GitLogEntry,
  native,
} from "@/modules/ai/lib/native";
import type { CommitDetailFilesEntry } from "@/modules/git-history/CommitDetail";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type CommitGraphItem =
  | { key: string; kind: "commit"; commit: GitLogEntry }
  | {
      key: string;
      kind: "file";
      commit: GitLogEntry;
      file: GitCommitFileChange;
    }
  | {
      key: string;
      kind: "status";
      commit: GitLogEntry;
      entry?: CommitDetailFilesEntry;
    };

/** 文件作为独立虚拟行，避免大量文件同时挂载或改变提交节点的高度。 */
export function flattenCommitRows(
  commits: GitLogEntry[],
  expanded: Set<string>,
  files: Map<string, CommitDetailFilesEntry>,
): CommitGraphItem[] {
  return commits.flatMap((commit): CommitGraphItem[] => {
    const rows: CommitGraphItem[] = [
      { key: commit.sha, kind: "commit", commit },
    ];
    if (!expanded.has(commit.sha)) return rows;
    const entry = files.get(commit.sha);
    if (entry?.state === "loaded" && entry.files.length) {
      rows.push(
        ...entry.files.map(
          (file): CommitGraphItem => ({
            key: `${commit.sha}:file:${file.path}`,
            kind: "file",
            commit,
            file,
          }),
        ),
      );
    } else {
      rows.push({ key: `${commit.sha}:status`, kind: "status", commit, entry });
    }
    return rows;
  });
}

export function useCommitGraph(
  repoRoot: string | null,
  requestedVisible: boolean,
) {
  const visible = useViewActive(requestedVisible);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const viewScope = useViewScopeKey();
  const [files, setFiles] = useViewState(
    `commitFiles:${repoRoot}`,
    () => new Map<string, CommitDetailFilesEntry>(),
  );
  const cache = useRef(files);
  const generation = useRef(0);
  const requests = useRef(new Set<string>());
  const [expanded, setExpanded] = useViewState(
    `commitsExpanded:${repoRoot}`,
    () => new Set<string>(),
  );
  const expandedRef = useRef(expanded);
  cache.current = files;
  expandedRef.current = expanded;
  const [anchor, setAnchor] = useState<{
    sha: string;
    element: HTMLElement;
    focus: boolean;
  } | null>(null);
  const current = useRef<typeof anchor>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const warmUntil = useRef(0);
  const blocked = useRef<string | null>(null);

  const close = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    if (current.current) warmUntil.current = Date.now() + TOOLTIP_SKIP_DELAY_MS;
    current.current = null;
    setAnchor(null);
  }, []);

  const fetchFiles = useCallback(
    async (sha: string, retry = false) => {
      if (!repoRoot || !visibleRef.current) return;
      const existing = cache.current.get(sha);
      if (
        requests.current.has(sha) ||
        (existing &&
          existing.state !== "loading" &&
          !(retry && existing.state === "error"))
      )
        return;
      requests.current.add(sha);
      const request = generation.current;
      const write = (entry: CommitDetailFilesEntry) => {
        cache.current = new Map(cache.current).set(sha, entry);
        // 展开项和正在请求的详情不能被淘汰；其余缓存保留最近的 16 条。
        const disposable = [...cache.current.keys()].filter(
          (key) =>
            key !== sha &&
            key !== current.current?.sha &&
            !expandedRef.current.has(key) &&
            cache.current.get(key)?.state !== "loading",
        );
        for (const key of disposable.slice(
          0,
          Math.max(0, disposable.length - 15),
        ))
          cache.current.delete(key);
        setFiles(cache.current);
      };
      write({ state: "loading" });
      try {
        const [changes, message] = await readViewResource(
          `commit-detail:${repoRoot}:${sha}`,
          () =>
            Promise.all([
              native.gitCommitFiles(repoRoot, sha),
              native.gitCommitMessage(repoRoot, sha),
            ]),
        );
        if (request === generation.current)
          write({ state: "loaded", files: changes, message });
      } catch (error) {
        if (request === generation.current)
          write({
            state: "error",
            error: error instanceof Error ? error.message : String(error),
          });
      } finally {
        if (request === generation.current) requests.current.delete(sha);
      }
    },
    [repoRoot],
  );

  /** 刷新后只清理已消失提交的交互状态，SHA 不变的详情缓存仍有效。 */
  const retainCommits = useCallback(
    (commits: { sha: string }[]) => {
      const known = new Set(commits.map((commit) => commit.sha));
      const next = new Set(
        [...expandedRef.current].filter((sha) => known.has(sha)),
      );
      if (next.size !== expandedRef.current.size) {
        expandedRef.current = next;
        setExpanded(next);
      }
      if (current.current && !known.has(current.current.sha)) close();
    },
    [close],
  );

  useEffect(() => {
    void repoRoot;
    void viewScope;
    close();
    blocked.current = null;
    warmUntil.current = 0;
    return () => {
      generation.current += 1;
      requests.current.clear();
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
    };
  }, [repoRoot, viewScope, close]);

  useEffect(() => {
    void viewScope;
    if (!visible) close();
    else for (const sha of expandedRef.current) void fetchFiles(sha);
  }, [visible, close, fetchFiles, viewScope]);

  const enter = useCallback(
    (sha: string, element: HTMLElement, immediate = false) => {
      clearTimeout(closeTimer.current);
      clearTimeout(openTimer.current);
      if (!visible || (!immediate && blocked.current === sha)) return;
      if (current.current?.sha === sha && !immediate) return;
      const show = () => {
        if (!element.isConnected) return;
        const next = { sha, element, focus: immediate };
        current.current = next;
        setAnchor(next);
        void fetchFiles(sha);
      };
      if (immediate || current.current || Date.now() < warmUntil.current)
        show();
      else openTimer.current = setTimeout(show, TOOLTIP_DELAY_MS);
    },
    [fetchFiles, visible],
  );

  const leave = useCallback(() => {
    blocked.current = null;
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    // 给指针穿过提交行与浮层间隙的时间，进入浮层后取消关闭。
    closeTimer.current = setTimeout(close, 100);
  }, [close]);
  const keepOpen = useCallback(() => {
    clearTimeout(closeTimer.current);
  }, []);
  const dismiss = useCallback(() => {
    blocked.current = current.current?.sha ?? null;
    close();
  }, [close]);
  const toggle = useCallback(
    (sha: string) => {
      blocked.current = sha;
      close();
      const next = new Set(expandedRef.current);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      expandedRef.current = next;
      setExpanded(next);
      if (next.has(sha)) void fetchFiles(sha);
    },
    [close, fetchFiles],
  );

  return useMemo(
    () => ({
      files,
      expanded,
      anchor,
      enter,
      leave,
      keepOpen,
      close,
      dismiss,
      toggle,
      fetchFiles,
      retainCommits,
    }),
    [
      files,
      expanded,
      anchor,
      enter,
      leave,
      keepOpen,
      close,
      dismiss,
      toggle,
      fetchFiles,
      retainCommits,
    ],
  );
}

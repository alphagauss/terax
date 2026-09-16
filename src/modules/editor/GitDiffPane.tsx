/**
 * 本文件实现工作区与历史提交的 Git diff 预览。
 * 两类资源使用独立生命周期，工作区 diff 按 revision 后台刷新并保留旧内容，提交 diff 仅按不可变资源身份加载。
 */

import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { native } from "@/modules/ai/lib/native";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { GitDiffResource } from "@/modules/source-control/gitTypes";
import { useRepositorySnapshot } from "@/modules/source-control/RepositoryContext";
import { unifiedMergeView } from "@codemirror/merge";
import type { Extension } from "@codemirror/state";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UNIFIED_DIFF_THEME } from "./lib/diffTheme";
import {
  buildSharedExtensions,
  DEFAULT_INDENT,
  languageCompartment,
  READONLY_EXTENSIONS,
} from "./lib/extensions";
import { gitChangeOverview } from "./lib/gitGutter";
import { resolveLanguage } from "./lib/languageResolver";
import { useEditorThemeExt } from "./lib/useEditorThemeExt";
import { SplitDiffView } from "./SplitDiffView";

const LARGE_FILE_THRESHOLD = 256 * 1024;
const SHARED_EXT = buildSharedExtensions();

type LoadState =
  | { kind: "loading" }
  | {
      kind: "loaded";
      originalContent: string;
      modifiedContent: string;
      isBinary: boolean;
      fallbackPatch: string;
      /** 需在 MergeView 挂载前解析，避免删除块部件缺少语法高亮。 */
      langExt: Extension | null;
      sourceKey?: string;
    }
  | { kind: "error"; message: string; sourceKey?: string };

type CommitDiffResource = {
  repoRoot: string;
  sha: string;
  path: string;
  originalPath: string | null;
};

function errorMessage(error: unknown): string {
  return error && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);
}

/** 生成工作区 diff 的稳定资源身份，不把仓库刷新次数混入资源本身。 */
function workingSourceKey(source: GitDiffResource): string {
  return `${source.repoRoot}\0${source.path}\0${source.side}\0${source.originalPath ?? ""}`;
}

/** 可见时按 revision 去重并后台刷新工作区差异，隐藏期间不发起读取。 */
export function WorkingGitDiffPane({
  source,
  active,
}: {
  source: GitDiffResource;
  active: boolean;
}) {
  const repository = useRepositorySnapshot();
  const { repoRoot, path, side, originalPath } = source;
  const revision =
    repository.repo?.repoRoot === repoRoot ? repository.revision : 0;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const loadedRef = useRef<{ sourceKey: string; revision: number } | null>(
    null,
  );
  const sourceKey = workingSourceKey(source);

  useEffect(() => {
    if (!active) return;
    if (
      loadedRef.current?.sourceKey === sourceKey &&
      loadedRef.current.revision === revision
    ) {
      return;
    }
    let cancelled = false;
    const hasCurrentContent = loadedRef.current?.sourceKey === sourceKey;
    if (!hasCurrentContent) {
      loadedRef.current = null;
      setState({ kind: "loading" });
    }
    Promise.all([
      native.gitDiffContent(repoRoot, path, side, originalPath),
      resolveLanguage(path).catch(() => null),
    ])
      .then(([result, language]) => {
        if (cancelled) return;
        loadedRef.current = { sourceKey, revision };
        setState({
          kind: "loaded",
          originalContent: result.originalContent,
          modifiedContent: result.modifiedContent,
          isBinary: result.isBinary,
          fallbackPatch: result.fallbackPatch,
          langExt: language?.ext ?? null,
          sourceKey,
        });
      })
      .catch((error) => {
        if (!cancelled && !hasCurrentContent) {
          setState({
            kind: "error",
            message: errorMessage(error),
            sourceKey,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, originalPath, path, repoRoot, revision, side, sourceKey]);

  const visibleState =
    state.kind === "loaded" || state.kind === "error"
      ? state.sourceKey === sourceKey
        ? state
        : { kind: "loading" as const }
      : state;
  return <DiffContent path={path} state={visibleState} />;
}

/** 按不可变提交资源身份读取一次历史差异。 */
export function CommitGitDiffPane({ source }: { source: CommitDiffResource }) {
  const { repoRoot, sha, path, originalPath } = source;
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    Promise.all([
      native.gitCommitFileDiff(repoRoot, sha, path, originalPath),
      resolveLanguage(path).catch(() => null),
    ])
      .then(([result, language]) => {
        if (cancelled) return;
        setState({
          kind: "loaded",
          originalContent: result.originalContent,
          modifiedContent: result.modifiedContent,
          isBinary: result.isBinary,
          fallbackPatch: result.fallbackPatch,
          langExt: language?.ext ?? null,
        });
      })
      .catch((error) => {
        if (!cancelled)
          setState({ kind: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [originalPath, path, repoRoot, sha]);

  return <DiffContent path={path} state={state} />;
}

/** 渲染已加载的统一或左右分栏差异内容。 */
function DiffContent({ path, state }: { path: string; state: LoadState }) {
  const { t } = useTranslation("editor");
  const themeExt = useEditorThemeExt();
  const diffViewMode = usePreferencesStore((current) => current.diffViewMode);
  const loaded = state.kind === "loaded" ? state : null;
  const originalContent = loaded?.originalContent ?? "";
  const modifiedContent = loaded?.modifiedContent ?? "";
  const fallbackPatch = loaded?.fallbackPatch ?? "";
  const useFallback =
    (loaded?.isBinary ?? false) ||
    originalContent.length > LARGE_FILE_THRESHOLD ||
    modifiedContent.length > LARGE_FILE_THRESHOLD;
  const effectiveDiffViewMode =
    loaded &&
    diffViewMode === "split" &&
    (originalContent.length === 0 || modifiedContent.length === 0)
      ? "inline"
      : diffViewMode;
  const extensions = useMemo(
    () =>
      effectiveDiffViewMode === "split"
        ? []
        : [
            ...SHARED_EXT,
            DEFAULT_INDENT,
            languageCompartment.of(loaded?.langExt ?? []),
            ...READONLY_EXTENSIONS,
            unifiedMergeView({
              original: originalContent,
              mergeControls: false,
              highlightChanges: true,
              gutter: true,
              syntaxHighlightDeletions: true,
            }),
            gitChangeOverview,
            UNIFIED_DIFF_THEME,
          ],
    [effectiveDiffViewMode, loaded?.langExt, originalContent],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-hidden">
        {state.kind === "loading" ? (
          <div className="flex h-full items-center justify-center gap-2 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            {t("diff.loading")}
          </div>
        ) : state.kind === "error" ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-[11.5px] text-destructive">
            {state.message}
          </div>
        ) : useFallback ? (
          <ScrollArea className="h-full">
            <pre className="min-h-full whitespace-pre-wrap wrap-break-word p-4 font-mono text-[12px] leading-relaxed text-muted-foreground">
              {fallbackPatch || t("diff.unavailable")}
            </pre>
          </ScrollArea>
        ) : effectiveDiffViewMode === "split" ? (
          <SplitDiffView
            original={originalContent}
            modified={modifiedContent}
            path={path}
          />
        ) : (
          <CodeMirror
            value={modifiedContent}
            theme={themeExt}
            extensions={extensions}
            editable={false}
            height="100%"
            className="h-full"
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
              searchKeymap: true,
            }}
          />
        )}
      </div>
    </div>
  );
}

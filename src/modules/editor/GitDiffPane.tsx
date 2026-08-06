/**
 * 本文件实现工作区与历史提交的 Git diff 预览。
 * working diff 在激活和仓库变化时读取真实内容，commit diff 在页面挂载期间只读取一次。
 */

import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { native } from "@/modules/ai/lib/native";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useRepositoryGeneration } from "@/modules/source-control/repositoryChanges";
import { unifiedMergeView } from "@codemirror/merge";
import type { Extension } from "@codemirror/state";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef, useState } from "react";
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

type WorkingSource = {
  kind: "working";
  repoRoot: string;
  path: string;
  mode: "-" | "+";
  originalPath: string | null;
};

type CommitSource = {
  kind: "commit";
  repoRoot: string;
  sha: string;
  path: string;
  originalPath: string | null;
};

type Props = {
  source: WorkingSource | CommitSource;
  active: boolean;
};

const LARGE_FILE_THRESHOLD = 256 * 1024;

const SHARED_EXT = buildSharedExtensions();

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "loaded";
      originalContent: string;
      modifiedContent: string;
      isBinary: boolean;
      fallbackPatch: string;
      /** Resolved before mount: a late compartment reconfigure would leave
       * the merge view's deleted-chunk widgets unhighlighted. */
      langExt: Extension | null;
    }
  | { kind: "error"; message: string };

function sourceKey(source: WorkingSource | CommitSource): string {
  return source.kind === "working"
    ? `working\0${source.repoRoot}\0${source.mode}\0${source.path}\0${source.originalPath ?? ""}`
    : `commit\0${source.repoRoot}\0${source.sha}\0${source.path}\0${source.originalPath ?? ""}`;
}

/**
 * 展示工作区或历史提交的只读文件 diff。
 *
 * 隐藏的 working diff 只记录仓库 generation，重新可见后再读取；commit diff 在同一页面实例内复用已加载内容。
 */
export function GitDiffPane({ source, active }: Props) {
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const loadedCommitKeyRef = useRef<string | null>(null);
  const themeExt = useEditorThemeExt();
  const diffViewMode = usePreferencesStore((s) => s.diffViewMode);
  const generation = useRepositoryGeneration(source.repoRoot);
  const workingGeneration = source.kind === "working" ? generation : 0;
  const [state, setState] = useState<LoadState>({ kind: "idle" });

  const key = sourceKey(source);

  useEffect(() => {
    void workingGeneration;
    void key;
    if (!active) return;
    const requestedSource = sourceRef.current;
    if (
      requestedSource.kind === "commit" &&
      loadedCommitKeyRef.current === key
    ) {
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    const promise =
      requestedSource.kind === "working"
        ? native.gitDiffContent(
            requestedSource.repoRoot,
            requestedSource.path,
            requestedSource.mode === "+",
            requestedSource.originalPath,
          )
        : native.gitCommitFileDiff(
            requestedSource.repoRoot,
            requestedSource.sha,
            requestedSource.path,
            requestedSource.originalPath,
          );
    Promise.all([
      promise,
      resolveLanguage(requestedSource.path).catch(() => null),
    ])
      .then(([res, lang]) => {
        if (cancelled) return;
        loadedCommitKeyRef.current =
          requestedSource.kind === "commit" ? key : null;
        setState({
          kind: "loaded",
          originalContent: res.originalContent,
          modifiedContent: res.modifiedContent,
          isBinary: res.isBinary,
          fallbackPatch: res.fallbackPatch,
          langExt: lang?.ext ?? null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            err && typeof err === "object" && "message" in err
              ? String((err as { message: unknown }).message)
              : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [active, key, workingGeneration]);

  const path = source.path;
  const loaded = state.kind === "loaded" ? state : null;
  const originalContent = loaded?.originalContent ?? "";
  const modifiedContent = loaded?.modifiedContent ?? "";
  const isBinary = loaded?.isBinary ?? false;
  const fallbackPatch = loaded?.fallbackPatch ?? "";

  const isTooLarge =
    originalContent.length > LARGE_FILE_THRESHOLD ||
    modifiedContent.length > LARGE_FILE_THRESHOLD;
  const useFallback = isBinary || isTooLarge;

  const langExt = loaded?.langExt ?? null;
  const extensions = useMemo(
    () =>
      diffViewMode === "split"
        ? []
        : [
            ...SHARED_EXT,
            DEFAULT_INDENT,
            languageCompartment.of(langExt ?? []),
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
    [originalContent, langExt, diffViewMode],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-hidden">
        {state.kind === "loading" || state.kind === "idle" ? (
          <div className="flex h-full items-center justify-center gap-2 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            Loading diff…
          </div>
        ) : state.kind === "error" ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-[11.5px] text-destructive">
            {state.message}
          </div>
        ) : useFallback ? (
          <ScrollArea className="h-full">
            <pre className="min-h-full whitespace-pre-wrap wrap-break-word p-4 font-mono text-[12px] leading-relaxed text-muted-foreground">
              {fallbackPatch || "Diff preview is not available for this file."}
            </pre>
          </ScrollArea>
        ) : diffViewMode === "split" ? (
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

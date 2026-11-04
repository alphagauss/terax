/**
 * 本文件实现工作区与历史提交的 Git diff 预览。
 * 两类资源使用独立生命周期，工作区 diff 按 revision 后台刷新并保留旧内容，提交 diff 仅按不可变资源身份加载。
 */

import { readViewResource, useViewActive } from "@/modules/view-state";
import { Spinner } from "@/components/ui/spinner";
import { native } from "@/modules/ai/lib/native";
import type { FindHandle } from "@/modules/find";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { GitDiffResource } from "@/modules/source-control/gitTypes";
import { useRepositorySnapshot } from "@/modules/source-control/RepositoryContext";
import { unifiedMergeView } from "@codemirror/merge";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import {
  forwardRef,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { deletedFileDiff } from "./lib/deletedFileDiff";
import { unifiedDiffLineNumbers } from "./lib/unifiedDiffLineNumbers";
import { UNIFIED_DIFF_THEME } from "./lib/diffTheme";
import {
  buildSharedExtensions,
  DEFAULT_INDENT,
  FOCUSABLE_READONLY_EXTENSIONS,
  languageCompartment,
  reconfigureWordWrap,
  wrapCompartment,
} from "./lib/extensions";
import { openEditorFindPanel } from "./lib/find/editorFindPanel";
import { gitChangeOverview } from "./lib/gitGutter";
import { resolveLanguage } from "./lib/languageResolver";
import {
  matchesTemporaryWordWrapShortcut,
  useTemporaryWordWrap,
} from "./lib/temporaryWordWrap";
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
export const WorkingGitDiffPane = forwardRef<
  FindHandle,
  {
    source: GitDiffResource;
    active: boolean;
  }
>(function WorkingGitDiffPane({ source, active: requestedActive }, ref) {
  const active = useViewActive(requestedActive);
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
      readViewResource(`working-diff:${sourceKey}:${revision}`, () =>
        native.gitDiffContent(repoRoot, path, side, originalPath),
      ),
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
      loadedRef.current = loadedRef.current
        ? { ...loadedRef.current, revision: -1 }
        : null;
    };
  }, [active, originalPath, path, repoRoot, revision, side, sourceKey]);

  const visibleState =
    state.kind === "loaded" || state.kind === "error"
      ? state.sourceKey === sourceKey
        ? state
        : { kind: "loading" as const }
      : state;
  return <DiffContent ref={ref} path={path} state={visibleState} />;
});

/** 按不可变提交资源身份读取一次历史差异。 */
export const CommitGitDiffPane = forwardRef<
  FindHandle,
  { source: CommitDiffResource }
>(function CommitGitDiffPane({ source }, ref) {
  const active = useViewActive();
  const loaded = useRef<string | null>(null);
  const { repoRoot, sha, path, originalPath } = source;
  const resourceKey = `${repoRoot}\0${sha}\0${path}\0${originalPath ?? ""}`;
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    if (!active || loaded.current === resourceKey) return;
    let cancelled = false;
    setState({ kind: "loading" });
    Promise.all([
      readViewResource(`commit-diff:${resourceKey}`, () =>
        native.gitCommitFileDiff(repoRoot, sha, path, originalPath),
      ),
      resolveLanguage(path).catch(() => null),
    ])
      .then(([result, language]) => {
        if (cancelled) return;
        loaded.current = resourceKey;
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
  }, [active, resourceKey, originalPath, path, repoRoot, sha]);

  return <DiffContent ref={ref} path={path} state={state} />;
});

/** 渲染已加载的统一或左右分栏差异内容。 */
const DiffContent = forwardRef<FindHandle, { path: string; state: LoadState }>(
  function DiffContent({ path, state }, ref) {
    const { t } = useTranslation("editor");
    const themeExt = useEditorThemeExt();
    const diffViewMode = usePreferencesStore((current) => current.diffViewMode);
    const [wordWrap, toggleTemporaryWordWrap] = useTemporaryWordWrap();
    const handleKeyDownCapture = useCallback(
      (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229 ||
          !matchesTemporaryWordWrapShortcut(event.nativeEvent)
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        toggleTemporaryWordWrap();
      },
      [toggleTemporaryWordWrap],
    );
    const loaded = state.kind === "loaded" ? state : null;
    const originalContent = loaded?.originalContent ?? "";
    const modifiedContent = loaded?.modifiedContent ?? "";
    const fallbackPatch = loaded?.fallbackPatch ?? "";
    const editorRef = useRef<EditorView | null>(null);
    const splitRef = useRef<FindHandle>(null);
    const useFallback =
      (loaded?.isBinary ?? false) ||
      originalContent.length > LARGE_FILE_THRESHOLD ||
      modifiedContent.length > LARGE_FILE_THRESHOLD;
    const isDeletion =
      originalContent.length > 0 && modifiedContent.length === 0;
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
              ...FOCUSABLE_READONLY_EXTENSIONS,
              wrapCompartment.of([]),
              ...(isDeletion
                ? [deletedFileDiff]
                : [
                    unifiedMergeView({
                      original: originalContent,
                      mergeControls: false,
                      highlightChanges: true,
                      gutter: false,
                      syntaxHighlightDeletions: true,
                    }),
                    gitChangeOverview,
                    unifiedDiffLineNumbers,
                    UNIFIED_DIFF_THEME,
                  ]),
            ],
      [effectiveDiffViewMode, isDeletion, loaded?.langExt, originalContent],
    );
    const fallbackExtensions = useMemo(
      () => [
        ...SHARED_EXT,
        DEFAULT_INDENT,
        ...FOCUSABLE_READONLY_EXTENSIONS,
        wrapCompartment.of([]),
      ],
      [],
    );

    useEffect(() => {
      if (effectiveDiffViewMode === "split" && !useFallback) {
        editorRef.current = null;
        return;
      }
      const view = editorRef.current;
      if (!view) return;
      reconfigureWordWrap(view, wordWrap);
    }, [effectiveDiffViewMode, useFallback, wordWrap]);

    const registerEditor = useCallback(
      (view: EditorView) => {
        editorRef.current = view;
        reconfigureWordWrap(view, wordWrap);
      },
      [wordWrap],
    );

    useImperativeHandle(ref, () => ({
      open: () => {
        if (!loaded) return;
        if (effectiveDiffViewMode === "split" && !useFallback) {
          splitRef.current?.open();
          return;
        }
        if (editorRef.current) openEditorFindPanel(editorRef.current);
      },
    }));

    return (
      <div
        className="flex h-full min-h-0 flex-col bg-background"
        onKeyDownCapture={handleKeyDownCapture}
      >
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
            <CodeMirror
              value={fallbackPatch || t("diff.unavailable")}
              theme={themeExt}
              extensions={fallbackExtensions}
              editable={false}
              height="100%"
              className="h-full"
              onCreateEditor={registerEditor}
              basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                highlightActiveLine: false,
                highlightActiveLineGutter: false,
                searchKeymap: true,
              }}
            />
          ) : effectiveDiffViewMode === "split" ? (
            <SplitDiffView
              ref={splitRef}
              original={originalContent}
              modified={modifiedContent}
              path={path}
              wordWrap={wordWrap}
            />
          ) : (
            <CodeMirror
              value={isDeletion ? originalContent : modifiedContent}
              theme={themeExt}
              extensions={extensions}
              editable={false}
              height="100%"
              className="h-full"
              onCreateEditor={registerEditor}
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
  },
);

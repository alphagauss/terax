import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { unifiedMergeView } from "@codemirror/merge";
import type { Extension } from "@codemirror/state";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  commitDiffKey,
  fetchCommitDiff,
  fetchWorkingDiff,
  getCachedDiff,
  workingDiffKey,
} from "./lib/diffCache";
import { UNIFIED_DIFF_THEME } from "./lib/diffTheme";
import {
  buildSharedExtensions,
  DEFAULT_INDENT,
  languageCompartment,
  READONLY_EXTENSIONS,
} from "./lib/extensions";
import {
  gitChangeOverview,
  gitChangesForDiff,
  setGitChanges,
} from "./lib/gitGutter";
import { resolveLanguage, resolveLanguageSync } from "./lib/languageResolver";
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

function cacheKey(source: WorkingSource | CommitSource): string {
  return source.kind === "working"
    ? workingDiffKey(source.repoRoot, source.path, source.mode)
    : commitDiffKey(source.repoRoot, source.sha, source.path);
}

function loadStateFromCache(source: WorkingSource | CommitSource): LoadState {
  const hit = getCachedDiff(cacheKey(source));
  if (!hit) return { kind: "idle" };
  return {
    kind: "loaded",
    originalContent: hit.originalContent,
    modifiedContent: hit.modifiedContent,
    isBinary: hit.isBinary,
    fallbackPatch: hit.fallbackPatch,
    langExt: resolveLanguageSync(source.path)?.ext ?? null,
  };
}

export function GitDiffPane({ source, active }: Props) {
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const themeExt = useEditorThemeExt();
  const diffViewMode = usePreferencesStore((s) => s.diffViewMode);
  const [state, setState] = useState<LoadState>(() =>
    active ? loadStateFromCache(source) : { kind: "idle" },
  );

  const key = cacheKey(source);

  useEffect(() => {
    if (!active) return;
    const cached = loadStateFromCache(source);
    if (cached.kind === "loaded") {
      setState(cached);
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    const promise =
      source.kind === "working"
        ? fetchWorkingDiff(
            source.repoRoot,
            source.path,
            source.mode,
            source.originalPath,
          )
        : fetchCommitDiff(
            source.repoRoot,
            source.sha,
            source.path,
            source.originalPath,
          );
    Promise.all([promise, resolveLanguage(source.path).catch(() => null)])
      .then(([res, lang]) => {
        if (cancelled) return;
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
  }, [active, key, source]);

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
  const overviewChanges = useMemo(
    () => gitChangesForDiff(fallbackPatch, originalContent, modifiedContent),
    [fallbackPatch, originalContent, modifiedContent],
  );
  const extensions = useMemo(
    () =>
      diffViewMode === "split"
        ? []
        : [
            ...SHARED_EXT,
            DEFAULT_INDENT,
            languageCompartment.of(langExt ?? []),
            ...READONLY_EXTENSIONS,
            gitChangeOverview,
            unifiedMergeView({
              original: originalContent,
              mergeControls: false,
              highlightChanges: true,
              gutter: true,
              syntaxHighlightDeletions: true,
            }),
            UNIFIED_DIFF_THEME,
          ],
    [originalContent, langExt, diffViewMode],
  );

  useEffect(() => {
    if (diffViewMode !== "inline" || useFallback) return;
    cmRef.current?.view?.dispatch({
      effects: setGitChanges.of(overviewChanges),
    });
  }, [diffViewMode, overviewChanges, useFallback]);

  // Cache-hit path only: the diff came from the cache before the language
  // pack was imported. Resolve and reconfigure once the view exists.
  useEffect(() => {
    if (
      diffViewMode === "split" ||
      useFallback ||
      state.kind !== "loaded" ||
      state.langExt
    )
      return;
    let cancelled = false;
    resolveLanguage(path).then((res) => {
      if (cancelled || !res) return;
      setState((s) => (s.kind === "loaded" ? { ...s, langExt: res.ext } : s));
    });
    return () => {
      cancelled = true;
    };
  }, [useFallback, path, state, diffViewMode]);

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
            changes={overviewChanges}
          />
        ) : (
          <CodeMirror
            ref={cmRef}
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

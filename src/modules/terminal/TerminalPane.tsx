/**
 * 本文件渲染单个终端叶子视图及其查找、命令块和启动反馈。
 * 终端会话由模块级池持有，视图隐藏时不会销毁 PTY。
 */

import { Spinner } from "@/components/ui/spinner";
import { usePresence } from "@/lib/usePresence";
import {
  FIND_PRESENCE_MS,
  type FindHandle,
  type FindOptions,
  type FindResult,
  FindWidget,
  type FindWidgetHandle,
} from "@/modules/find";
import { useTheme } from "@/modules/theme";
import { currentWorkspaceEnv } from "@/modules/workspace";
import type { SearchAddon } from "@xterm/addon-search";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { BlockOverlay } from "./block/BlockOverlay";
import { BlockWatermark } from "./block/BlockWatermark";
import {
  focusLeafInput,
  submitToLeaf,
  useTerminalSession,
  whenSessionReady,
} from "./lib/useTerminalSession";

const TERM_DECORATIONS = {
  matchBackground: "#515c6a",
  activeMatchBackground: "#d18616",
  matchOverviewRuler: "#d18616",
  activeMatchColorOverviewRuler: "#d18616",
};

const DEFAULT_FIND_OPTIONS: FindOptions = {
  caseSensitive: false,
  wholeWord: false,
  regexp: false,
};

function hasInvalidRegex(query: string, options: FindOptions): boolean {
  if (!query || !options.regexp) return false;
  try {
    new RegExp(query);
    return false;
  } catch {
    return true;
  }
}

export type TerminalPaneHandle = FindHandle & {
  write: (data: string) => void;
  focus: () => void;
  getBuffer: (maxLines?: number) => string | null;
  getSelection: () => string | null;
};

type Props = {
  /** Stable identifier for this leaf (passed back through callbacks). */
  leafId: number;
  /** Tab containing this pane is on screen. */
  visible: boolean;
  /** 当前叶子在标签页内激活时接收自动聚焦。 */
  focused?: boolean;
  initialCwd?: string;
  /** Enable command-block decorations (OSC 133) for this terminal. */
  blocks?: boolean;
  onExit?: (leafId: number, code: number) => void;
  onCwd?: (leafId: number, cwd: string) => void;
};

/**
 * 单个终端叶子组件。
 *
 * 复用模块级 PTY 会话，并在前台 shell 首次就绪前显示局部加载反馈。
 */
export const TerminalPane = memo(
  forwardRef<TerminalPaneHandle, Props>(function TerminalPane(
    {
      leafId,
      visible,
      focused = true,
      initialCwd,
      blocks = false,
      onExit,
      onCwd,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const findWidgetRef = useRef<FindWidgetHandle>(null);
    const downYRef = useRef<number | null>(null);
    const [findOpen, setFindOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [findOptions, setFindOptions] =
      useState<FindOptions>(DEFAULT_FIND_OPTIONS);
    const [searchAddon, setSearchAddon] = useState<SearchAddon | null>(null);
    const [findResult, setFindResult] = useState<FindResult>();
    const remoteWorkspace = currentWorkspaceEnv().kind !== "local";
    const [shellReady, setShellReady] = useState(!remoteWorkspace);
    const findPresence = usePresence(findOpen, FIND_PRESENCE_MS);
    const { resolvedMode, themeId, customThemes } = useTheme();
    const { t } = useTranslation("common");

    const session = useTerminalSession({
      leafId,
      container: containerRef,
      visible,
      focused,
      initialCwd,
      blocks,
      onSearchReady: setSearchAddon,
      onExit: (c) => onExit?.(leafId, c),
      onCwd: (c) => onCwd?.(leafId, c),
    });

    useEffect(() => {
      if (!remoteWorkspace) {
        setShellReady(true);
        return;
      }
      let active = true;
      setShellReady(false);
      void whenSessionReady(leafId).then(() => {
        if (active) setShellReady(true);
      });
      return () => {
        active = false;
      };
    }, [leafId, remoteWorkspace]);

    useEffect(() => {
      // Defer one frame so CSS-variable token resolution sees the new class.
      const id = requestAnimationFrame(() => session.applyTheme());
      return () => cancelAnimationFrame(id);
    }, [resolvedMode, themeId, customThemes, session]);

    const invalidRegex = useMemo(
      () => hasInvalidRegex(query, findOptions),
      [findOptions, query],
    );

    useEffect(() => {
      if (!searchAddon) return;
      const subscription = searchAddon.onDidChangeResults((result) => {
        setFindResult({
          current: result.resultIndex >= 0 ? result.resultIndex + 1 : undefined,
          total: result.resultCount,
        });
      });
      return () => subscription.dispose();
    }, [searchAddon]);

    useEffect(() => {
      if (!searchAddon) return;
      if (!query || invalidRegex) {
        searchAddon.clearDecorations();
        setFindResult(query ? { total: 0 } : undefined);
        return;
      }
      searchAddon.findNext(query, {
        ...findOptions,
        incremental: true,
        decorations: TERM_DECORATIONS,
      });
    }, [findOptions, invalidRegex, query, searchAddon]);

    const restoreFocus = useCallback(() => {
      if (blocks && session.blockMode === "prompt") focusLeafInput(leafId);
      else session.focus();
    }, [blocks, leafId, session]);

    const closeFind = useCallback(() => {
      searchAddon?.clearDecorations();
      setFindOpen(false);
      restoreFocus();
    }, [restoreFocus, searchAddon]);

    useEffect(() => {
      if (findPresence.mounted) return;
      setQuery("");
      setFindResult(undefined);
    }, [findPresence.mounted]);

    const openFind = useCallback(() => {
      const selection = session.getSelection();
      if (
        !query &&
        selection &&
        selection.length <= 200 &&
        !selection.includes("\n")
      ) {
        setQuery(selection);
      }
      setFindOpen(true);
      requestAnimationFrame(() => findWidgetRef.current?.focus(true));
    }, [query, session]);

    useImperativeHandle(
      ref,
      () => ({
        open: openFind,
        write: (data: string) => session.write(data),
        focus: () => session.focus(),
        getBuffer: (max?: number) => session.getBuffer(max),
        getSelection: () => session.getSelection(),
      }),
      [openFind, session],
    );

    const hideStyle = {
      visibility: visible ? ("visible" as const) : ("hidden" as const),
      pointerEvents: visible ? ("auto" as const) : ("none" as const),
    };

    const promptReady = session.blockMode === "prompt";
    const loadingIndicator =
      visible && !shellReady ? (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-background">
          <Spinner
            className="size-4 motion-reduce:animate-none"
            aria-label={t("loading")}
          />
        </div>
      ) : null;
    const findWidget =
      findPresence.mounted && visible ? (
        <div className="pointer-events-none absolute top-1 right-6 left-2 z-30 flex justify-end">
          <FindWidget
            ref={findWidgetRef}
            className="pointer-events-auto"
            state={findPresence.state}
            query={query}
            options={findOptions}
            result={findResult}
            invalid={invalidRegex}
            onQueryChange={setQuery}
            onOptionsChange={setFindOptions}
            onPrevious={() => {
              if (!query || invalidRegex) return;
              searchAddon?.findPrevious(query, {
                ...findOptions,
                decorations: TERM_DECORATIONS,
              });
            }}
            onNext={() => {
              if (!query || invalidRegex) return;
              searchAddon?.findNext(query, {
                ...findOptions,
                decorations: TERM_DECORATIONS,
              });
            }}
            onClose={closeFind}
          />
        </div>
      ) : null;

    if (blocks) {
      return (
        <div
          className="zoom-exempt flex h-full w-full flex-col"
          style={hideStyle}
        >
          <div className="relative min-h-0 flex-1">
            {loadingIndicator}
            {findWidget}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: terminal surface; pointer selects command blocks */}
            <div
              ref={containerRef}
              className="absolute inset-0 z-0"
              onMouseDown={(e) => {
                downYRef.current = e.clientY;
              }}
              onMouseUp={(e) => {
                const moved =
                  downYRef.current != null &&
                  Math.abs(e.clientY - downYRef.current) > 4;
                downYRef.current = null;
                if (!moved) session.selectBlockAt(e.clientY);
                if (session.blockMode === "prompt") focusLeafInput(leafId);
              }}
            />
            <BlockWatermark
              leafId={leafId}
              subscribe={session.subscribeBlocks}
            />
            <BlockOverlay
              subscribe={session.subscribeBlocks}
              getVisible={session.visibleBlocks}
              readOutput={(id) => session.readBlockId(id)?.output ?? null}
              searchBlock={session.searchBlock}
              revealMatch={session.revealMatch}
              clearSearch={session.clearSearch}
              promptReady={promptReady}
              onRunAgain={(cmd) => submitToLeaf(leafId, cmd)}
              onRestoreFocus={() => {
                if (session.blockMode === "prompt") focusLeafInput(leafId);
              }}
            />
          </div>
        </div>
      );
    }

    return (
      <div className="zoom-exempt relative h-full w-full" style={hideStyle}>
        {loadingIndicator}
        {findWidget}
        <div ref={containerRef} className="absolute inset-0" />
      </div>
    );
  }),
);

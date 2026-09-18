/**
 * 本文件实现只读的左右分栏 Git diff 视图。
 *
 * 负责同步两侧编辑器、独立横向滚动条和基于外层 MergeView 滚动区域的变更概览。
 */

import type { FindHandle } from "@/modules/find";
import { defaultKeymap } from "@codemirror/commands";
import { foldGutter } from "@codemirror/language";
import { MergeView } from "@codemirror/merge";
import { searchKeymap } from "@codemirror/search";
import { Compartment, type Extension } from "@codemirror/state";
import {
  EditorView,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { SPLIT_DIFF_THEME } from "./lib/diffTheme";
import {
  buildSharedExtensions,
  DEFAULT_INDENT,
  FOCUSABLE_READONLY_EXTENSIONS,
  languageCompartment,
  reconfigureWordWrap,
  wrapCompartment,
} from "./lib/extensions";
import { openEditorFindPanel } from "./lib/find/editorFindPanel";
import { renderGitChangeOverview } from "./lib/gitGutter";
import { resolveLanguage, resolveLanguageSync } from "./lib/languageResolver";
import { rangesFromChunks } from "./lib/quickDiff";
import { useEditorThemeExt } from "./lib/useEditorThemeExt";
import "./SplitDiffView.css";

const SHARED_EXT = buildSharedExtensions();
const themeCompartment = new Compartment();

type SplitDiffViewProps = {
  original: string;
  modified: string;
  path: string;
  wordWrap: boolean;
};

function replaceDoc(view: EditorView, doc: string) {
  if (view.state.doc.toString() === doc) return;

  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: doc,
    },
  });
}

function bindHorizontalScrollbar(
  view: EditorView,
  scrollbar: HTMLDivElement,
  sizer: HTMLDivElement,
) {
  const syncSize = () => {
    sizer.style.width = `${view.scrollDOM.scrollWidth}px`;
    scrollbar.scrollLeft = view.scrollDOM.scrollLeft;
  };
  const onScrollbarScroll = () => {
    if (view.scrollDOM.scrollLeft !== scrollbar.scrollLeft) {
      view.scrollDOM.scrollLeft = scrollbar.scrollLeft;
    }
  };
  const onEditorScroll = () => {
    if (scrollbar.scrollLeft !== view.scrollDOM.scrollLeft) {
      scrollbar.scrollLeft = view.scrollDOM.scrollLeft;
    }
  };
  const observer = new ResizeObserver(syncSize);
  observer.observe(view.contentDOM);
  observer.observe(view.scrollDOM);
  scrollbar.addEventListener("scroll", onScrollbarScroll);
  view.scrollDOM.addEventListener("scroll", onEditorScroll);
  const frame = requestAnimationFrame(syncSize);

  return {
    syncSize,
    destroy: () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scrollbar.removeEventListener("scroll", onScrollbarScroll);
      view.scrollDOM.removeEventListener("scroll", onEditorScroll);
    },
  };
}

/**
 * 左右分栏展示原始内容和修改后内容，并在可纵向滚动时显示 Git 变更概览。
 */
export const SplitDiffView = forwardRef<FindHandle, SplitDiffViewProps>(
  function SplitDiffView({ original, modified, path, wordWrap }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const leftScrollbarRef = useRef<HTMLDivElement>(null);
    const rightScrollbarRef = useRef<HTMLDivElement>(null);
    const leftSizerRef = useRef<HTMLDivElement>(null);
    const rightSizerRef = useRef<HTMLDivElement>(null);
    const railRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<MergeView | null>(null);
    const lastFocusedViewRef = useRef<EditorView | null>(null);
    const syncScrollbarsRef = useRef<() => void>(() => undefined);
    const originalRef = useRef(original);
    originalRef.current = original;
    const modifiedRef = useRef(modified);
    modifiedRef.current = modified;
    const themeExt = useEditorThemeExt();
    const themeRef = useRef(themeExt);
    themeRef.current = themeExt;
    const wordWrapRef = useRef(wordWrap);
    wordWrapRef.current = wordWrap;
    useEffect(() => {
      const parent = containerRef.current;
      if (!parent) return;

      let cancelled = false;
      let railFrame = 0;
      const renderRail = () => {
        const view = viewRef.current;
        const rail = railRef.current;
        if (view && rail) {
          renderGitChangeOverview(
            view.b,
            rail,
            rangesFromChunks(view.a.state.doc, view.b.state.doc, view.chunks),
            view.dom,
          );
        }
      };
      const scheduleRail = () => {
        cancelAnimationFrame(railFrame);
        railFrame = requestAnimationFrame(renderRail);
      };
      const language = resolveLanguageSync(path);
      const sideExtensions: Extension[] = [
        ...SHARED_EXT,
        DEFAULT_INDENT,
        lineNumbers(),
        foldGutter(),
        highlightSpecialChars(),
        keymap.of([...defaultKeymap, ...searchKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged || update.geometryChanged) scheduleRail();
        }),
        languageCompartment.of(language?.ext ?? []),
        themeCompartment.of(themeRef.current),
        ...FOCUSABLE_READONLY_EXTENSIONS,
        wrapCompartment.of(wordWrapRef.current ? EditorView.lineWrapping : []),
        SPLIT_DIFF_THEME,
      ];

      const view = new MergeView({
        a: {
          doc: originalRef.current,
          extensions: sideExtensions,
        },
        b: {
          doc: modifiedRef.current,
          extensions: sideExtensions,
        },
        parent,
        gutter: true,
        highlightChanges: true,
      });

      viewRef.current = view;
      const rememberLeftFocus = () => {
        lastFocusedViewRef.current = view.a;
      };
      const rememberRightFocus = () => {
        lastFocusedViewRef.current = view.b;
      };
      view.a.contentDOM.addEventListener("focus", rememberLeftFocus);
      view.b.contentDOM.addEventListener("focus", rememberRightFocus);
      view.dom.classList.add("app-scrollbar");
      const leftBinding = bindHorizontalScrollbar(
        view.a,
        leftScrollbarRef.current as HTMLDivElement,
        leftSizerRef.current as HTMLDivElement,
      );
      const rightBinding = bindHorizontalScrollbar(
        view.b,
        rightScrollbarRef.current as HTMLDivElement,
        rightSizerRef.current as HTMLDivElement,
      );
      syncScrollbarsRef.current = () => {
        leftBinding.syncSize();
        rightBinding.syncSize();
      };
      scheduleRail();

      if (!language) {
        void resolveLanguage(path)
          .then((resolved) => {
            if (cancelled || !resolved) return;

            for (const side of [view.a, view.b]) {
              side.dispatch({
                effects: languageCompartment.reconfigure(resolved.ext),
              });
            }
          })
          .catch(() => undefined);
      }

      return () => {
        cancelled = true;
        cancelAnimationFrame(railFrame);
        leftBinding.destroy();
        rightBinding.destroy();
        syncScrollbarsRef.current = () => undefined;
        view.a.contentDOM.removeEventListener("focus", rememberLeftFocus);
        view.b.contentDOM.removeEventListener("focus", rememberRightFocus);
        viewRef.current = null;
        view.destroy();
      };
    }, [path]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;

      replaceDoc(view.a, original);
      replaceDoc(view.b, modified);
      requestAnimationFrame(() => syncScrollbarsRef.current());
    }, [original, modified]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;

      for (const side of [view.a, view.b]) {
        side.dispatch({
          effects: themeCompartment.reconfigure(themeExt),
        });
      }
    }, [themeExt]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;

      for (const side of [view.a, view.b]) {
        reconfigureWordWrap(side, wordWrap);
      }
      requestAnimationFrame(() => syncScrollbarsRef.current());
    }, [wordWrap]);

    useImperativeHandle(ref, () => ({
      open: () => {
        const merge = viewRef.current;
        if (!merge) return;
        const target = merge.a.hasFocus
          ? merge.a
          : merge.b.hasFocus
            ? merge.b
            : (lastFocusedViewRef.current ?? merge.b);
        openEditorFindPanel(target);
      },
    }));

    return (
      <div className="split-diff-view relative flex h-full min-h-0 flex-col">
        <div
          ref={containerRef}
          className="relative min-h-0 flex-1 [&>.cm-mergeView]:h-full [&>.cm-mergeView]:overflow-x-hidden [&>.cm-mergeView]:overflow-y-auto"
        />
        <div ref={railRef} className="cm-changeOverview" aria-hidden="true" />
        <div className="grid h-[var(--scrollbar-size)] shrink-0 grid-cols-2">
          <div
            ref={leftScrollbarRef}
            className="split-diff-horizontal-scrollbar app-scrollbar overflow-x-auto overflow-y-hidden"
          >
            <div ref={leftSizerRef} className="h-px" />
          </div>
          <div
            ref={rightScrollbarRef}
            className="split-diff-horizontal-scrollbar app-scrollbar overflow-x-auto overflow-y-hidden"
          >
            <div ref={rightSizerRef} className="h-px" />
          </div>
        </div>
      </div>
    );
  },
);

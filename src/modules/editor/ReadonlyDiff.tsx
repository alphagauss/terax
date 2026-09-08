/** 审批、轮末预览与整轮页面共用的只读 Diff，内容只来自不可变快照。 */
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useState } from "react";
import {
  buildSharedExtensions,
  DEFAULT_INDENT,
  languageCompartment,
} from "@/modules/editor/lib/extensions";
import {
  resolveLanguage,
  resolveLanguageSync,
} from "@/modules/editor/lib/languageResolver";
import { useEditorThemeExt } from "@/modules/editor/lib/useEditorThemeExt";
import { UNIFIED_DIFF_THEME } from "@/modules/editor/lib/diffTheme";

const SHARED_EXT = buildSharedExtensions();
const READONLY_EXT = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
];
const PREVIEW_THEME = EditorView.theme({
  ".cm-scroller": { overflowX: "auto", overflowY: "auto" },
  ".cm-scroller::-webkit-scrollbar:horizontal": { height: "0" },
});

export function ReadonlyDiff({
  path,
  before,
  after,
  preview = false,
}: {
  path: string;
  before: string;
  after: string;
  preview?: boolean;
}) {
  const theme = useEditorThemeExt();
  const [language, setLanguage] = useState<{
    path: string;
    ext: Extension | null;
  }>(() => ({ path, ext: resolveLanguageSync(path)?.ext ?? null }));
  const lang = language.path === path ? language.ext : null;
  useEffect(() => {
    if (lang) return;
    let active = true;
    void resolveLanguage(path).then((result) => {
      if (active && result) setLanguage({ path, ext: result.ext });
    });
    return () => {
      active = false;
    };
  }, [path, lang]);
  const extensions = useMemo(
    () => [
      ...SHARED_EXT,
      DEFAULT_INDENT,
      languageCompartment.of(lang ?? []),
      ...READONLY_EXT,
      unifiedMergeView({
        original: before,
        mergeControls: false,
        highlightChanges: true,
        gutter: true,
        syntaxHighlightDeletions: true,
        collapseUnchanged: { margin: 3, minSize: 6 },
      }),
      UNIFIED_DIFF_THEME,
      ...(preview
        ? [
            PREVIEW_THEME,
            EditorView.domEventHandlers({
              wheel(event, view) {
                if (!event.shiftKey) return false;
                view.scrollDOM.scrollLeft += event.deltaX || event.deltaY;
                event.preventDefault();
                return true;
              },
            }),
          ]
        : []),
    ],
    [before, lang, preview],
  );
  return (
    <CodeMirror
      key={`${path}:${Boolean(lang)}`}
      value={after}
      theme={theme}
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
  );
}

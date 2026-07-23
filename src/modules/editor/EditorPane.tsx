/**
 * 本文件实现 CodeMirror 编辑器面板及其保存、格式化、语言服务和预览交互。
 *
 * 负责将共享文档模型连接到编辑器视图。保存失败必须向用户提示，不能静默丢失远程写入错误。
 */

import i18n from "@/i18n";
import { endpointIdFromCompatModel } from "@/modules/ai/config";
import { getCustomEndpointKey, getKey } from "@/modules/ai/lib/keyring";
import { native } from "@/modules/ai/lib/native";
import type { FindHandle } from "@/modules/find";
import { lspFormatDocument, useLspExtension } from "@/modules/lsp";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { onKeysChanged } from "@/modules/settings/store";
import { useWorkspaceEnvStore, workspaceScopeKey } from "@/modules/workspace";
import { acceptCompletion, startCompletion } from "@codemirror/autocomplete";
import { redo, undo } from "@codemirror/commands";
import { gotoLine } from "@codemirror/search";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  inlineCompletion,
  triggerInlineCompletion,
} from "./lib/autocomplete/inlineExtension";
import { diagnosticsReporter } from "./lib/diagnosticsReporter";
import { useDiagnosticsStore } from "./lib/diagnosticsStore";
import {
  buildSharedExtensions,
  DEFAULT_INDENT,
  indentCompartment,
  indentExtension,
  languageCompartment,
  lspCompartment,
  vimCompartment,
  wrapCompartment,
} from "./lib/extensions";
import {
  applyFormattedContent,
  readFileText,
  resolveFormatter,
  runExternalFormatter,
} from "./lib/externalFormat";
import {
  emptyGitChanges,
  gitChangeGutter,
  parseUnifiedDiff,
  setGitChanges,
} from "./lib/gitGutter";
import { detectIndentUnit } from "./lib/indent";
import { type LanguageResult, resolveLanguage } from "./lib/languageResolver";
import { openEditorFindPanel } from "./lib/find/editorFindPanel";
import { FORCE_READ_LIMIT, useDocument } from "./lib/useDocument";
import { useEditorThemeExt } from "./lib/useEditorThemeExt";
import { previewMediaKind, usePreviewAssetUrl } from "./lib/usePreviewAssetUrl";
import { initVimGlobals, vimHandlersExtension } from "./lib/vim";

initVimGlobals();

export type EditorPaneHandle = FindHandle & {
  focus: () => void;
  getSelection: () => string | null;
  getPath: () => string;
  /** Re-read the file from disk. Skips silently if the buffer is dirty. */
  reload: () => boolean;
  /** Move the cursor to a 1-based line and center it, once content is ready. */
  gotoLine: (line: number) => void;
  /** Scroll a 1-based source line to the viewport activation line. */
  scrollToSourceLine: (line: number) => void;
  /** Apply CodeMirror's undo/redo commands. */
  undo: () => void;
  redo: () => void;
  /** Request an AI ghost suggestion at the cursor. */
  triggerAiComplete: () => void;
  /** Open CodeMirror's completion popup. */
  triggerCodeComplete: () => void;
  /** Read the 1-based source line at the viewport activation line. */
  getViewportSourceLine: () => number | null;
};

type Props = {
  path: string;
  overrideLanguage?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
  onClose?: () => void;
  lspEnabled?: boolean;
  initialSourceLine?: number | null;
  onViewportSourceLineChange?: (line: number) => void;
};

export type EditorPaneProps = Props;

// Above this, syntax highlighting and LSP are disabled: a multi-MB lezer
// parse tree and a didOpen of that size cost far more than they give.
const SYNTAX_MAX_BYTES = 4 * 1024 * 1024;
const VIEWPORT_SOURCE_LINE_OFFSET = 32;

function editorViewportSourceLine(view: EditorView): number {
  const scrollRect = view.scrollDOM.getBoundingClientRect();
  const viewportTop = Math.max(
    0,
    (scrollRect.top - view.documentTop) / view.scaleY,
  );
  const block = view.lineBlockAtHeight(
    viewportTop + VIEWPORT_SOURCE_LINE_OFFSET / view.scaleY,
  );
  return view.state.doc.lineAt(block.from).number;
}

function restoreEditorSourceLine(view: EditorView, sourceLine: number) {
  const lineNumber = Math.max(1, Math.min(sourceLine, view.state.doc.lines));
  const line = view.state.doc.line(lineNumber);
  view.dispatch({
    effects: EditorView.scrollIntoView(line.from, {
      y: "start",
      yMargin: VIEWPORT_SOURCE_LINE_OFFSET,
    }),
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 代码编辑器面板。
 *
 * 负责渲染共享文档、处理保存和格式化，并在后台标签页中保持编辑器状态不被重建。
 */
export const EditorPane = memo(
  forwardRef<EditorPaneHandle, Props>(function EditorPane(props, ref) {
    const { t } = useTranslation("editor");
    const diagnosticsOwnerId = useId();
    const {
      path,
      overrideLanguage,
      onDirtyChange,
      onSaved,
      onClose,
      lspEnabled = true,
      initialSourceLine,
      onViewportSourceLineChange,
    } = props;

    const {
      doc,
      baselineContent,
      onChange,
      save,
      reload,
      adoptDiskText,
      openAnyway,
    } = useDocument({
      path,
      onDirtyChange,
    });
    const reloadRef = useRef(reload);
    reloadRef.current = reload;
    const adoptDiskTextRef = useRef(adoptDiskText);
    adoptDiskTextRef.current = adoptDiskText;
    const cmRef = useRef<ReactCodeMirrorRef>(null);
    const viewportLineChangeRef = useRef(onViewportSourceLineChange);
    viewportLineChangeRef.current = onViewportSourceLineChange;
    const themeExt = useEditorThemeExt();
    const vimMode = usePreferencesStore((s) => s.vimMode);
    const editorWordWrap = usePreferencesStore((s) => s.editorWordWrap);
    const workspace = useWorkspaceEnvStore((s) => s.env);
    const workspaceScope = workspaceScopeKey(workspace);
    const languageRef = useRef<string | null>(null);
    const [langId, setLangId] = useState<string | null>(null);
    const apiKeyRef = useRef<string | null>(null);

    useEffect(() => {
      let cancelled = false;
      const refresh = async () => {
        const s = usePreferencesStore.getState();
        const provider = s.autocompleteProvider;
        if (
          provider === "lmstudio" ||
          provider === "mlx" ||
          provider === "ollama"
        ) {
          apiKeyRef.current = null;
          return;
        }
        // OpenAI-compatible keys live in a per-endpoint keyring slot.
        if (provider === "openai-compatible") {
          const eid = endpointIdFromCompatModel(s.autocompleteModelId);
          const k = eid ? await getCustomEndpointKey(eid) : null;
          if (!cancelled) apiKeyRef.current = k;
          return;
        }
        const k = await getKey(provider);
        if (!cancelled) apiKeyRef.current = k;
      };
      void refresh();
      let unlistenKeys: (() => void) | undefined;
      void onKeysChanged(() => void refresh()).then((un) => {
        if (cancelled) un();
        else unlistenKeys = un;
      });
      const unsubPrefs = usePreferencesStore.subscribe((state, prev) => {
        if (
          state.autocompleteProvider !== prev.autocompleteProvider ||
          state.autocompleteModelId !== prev.autocompleteModelId
        ) {
          void refresh();
        }
      });
      return () => {
        cancelled = true;
        unlistenKeys?.();
        unsubPrefs();
      };
    }, []);
    // Stabilize save + onSaved via refs so the extensions array never changes
    // identity — a new identity makes @uiw/react-codemirror reconfigure the
    // whole state, wiping the language compartment.
    const saveRef = useRef(save);
    saveRef.current = save;
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const lspActiveRef = useRef(false);
    const warnedNoLspRef = useRef(false);
    const warnedNoFormatRef = useRef(false);
    const refreshGitGutterRef = useRef<() => void>(() => {});

    const performSave = useCallback(async () => {
      const view = cmRef.current?.view;
      const prefs = usePreferencesStore.getState();
      const formatter = resolveFormatter(languageRef.current, prefs);
      if (prefs.editorFormatOnSave && formatter === "lsp" && view) {
        if (lspActiveRef.current) {
          let res: "done" | "unsupported" = "done";
          try {
            res = await lspFormatDocument(view);
          } catch (e) {
            toast.error("Language server format failed", {
              description: String(e),
            });
          }
          if (res === "unsupported" && !warnedNoFormatRef.current) {
            warnedNoFormatRef.current = true;
            toast.warning("Format on save skipped", {
              description:
                "The active language server has no formatter. Pick an external one in Settings (Ruff for Python, Prettier, rustfmt, ...).",
            });
          }
        } else if (!warnedNoLspRef.current) {
          warnedNoLspRef.current = true;
          toast.warning(i18n.t("editor:formatOnSaveSkipped"), {
            description: i18n.t("editor:formatOnSaveSkippedDescription"),
          });
        }
      }
      // Snapshot before save: edits typed during the formatter round-trip
      // must not be clobbered by the disk read-back.
      const docAtSave = view?.state.doc;
      let saved: boolean;
      try {
        saved = await saveRef.current();
      } catch (error) {
        toast.error(i18n.t("editor:saveFailed"), {
          description: String(error),
        });
        return;
      }
      if (!saved) return;
      if (prefs.editorFormatOnSave && formatter !== "lsp") {
        const error = await runExternalFormatter(
          formatter,
          pathRef.current,
          prefs.editorCustomFormatCommand,
        );
        if (error) {
          toast.error(i18n.t("editor:formatFailed", { formatter }), {
            description: error,
          });
        } else {
          const readBack = await readFileText(pathRef.current);
          if (readBack !== null && view && view.state.doc === docAtSave) {
            applyFormattedContent(
              view,
              adoptDiskTextRef.current(readBack.text, readBack.mtime),
            );
          }
        }
      }
      onSavedRef.current?.();
      refreshGitGutterRef.current();
    }, []);
    const performSaveRef = useRef(performSave);
    performSaveRef.current = performSave;

    const pathRef = useRef(path);
    pathRef.current = path;
    const workspaceScopeRef = useRef(workspaceScope);
    workspaceScopeRef.current = workspaceScope;
    const gitGutterRequestRef = useRef(0);

    const refreshGitGutter = useCallback(async () => {
      const view = cmRef.current?.view;
      if (!view) return;
      const request = ++gitGutterRequestRef.current;
      const requestedPath = pathRef.current;
      const requestedScope = workspaceScopeRef.current;
      const stale = () =>
        request !== gitGutterRequestRef.current ||
        !view.dom.isConnected ||
        pathRef.current !== requestedPath ||
        workspaceScopeRef.current !== requestedScope;

      try {
        const normalizedPath = requestedPath.replace(/\\/g, "/");
        const slash = normalizedPath.lastIndexOf("/");
        const directory =
          slash > 0 ? normalizedPath.slice(0, slash) : normalizedPath;
        const repo = await native.gitResolveRepo(directory);
        if (stale()) return;
        if (!repo) {
          view.dispatch({ effects: setGitChanges.of(emptyGitChanges()) });
          return;
        }

        const root = repo.repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
        if (!normalizedPath.startsWith(`${root}/`)) {
          view.dispatch({ effects: setGitChanges.of(emptyGitChanges()) });
          return;
        }
        const relativePath = normalizedPath.slice(root.length + 1);
        const diff = await native.gitDiffHead(repo.repoRoot, relativePath);
        if (stale()) return;
        view.dispatch({
          effects: setGitChanges.of(
            diff.truncated
              ? emptyGitChanges()
              : parseUnifiedDiff(diff.diffText),
          ),
        });
      } catch {
        if (!stale()) {
          view.dispatch({ effects: setGitChanges.of(emptyGitChanges()) });
        }
      }
    }, []);
    refreshGitGutterRef.current = () => void refreshGitGutter();

    useEffect(() => {
      if (doc.status !== "ready") return;
      let frame = 0;
      const run = () => {
        if (cmRef.current?.view) void refreshGitGutter();
        else frame = requestAnimationFrame(run);
      };
      run();
      return () => cancelAnimationFrame(frame);
    }, [doc.status, refreshGitGutter]);

    const pendingLineRef = useRef<number | null>(null);
    const restoredSourceLineRef = useRef<number | null>(null);
    const statusRef = useRef(doc.status);
    statusRef.current = doc.status;

    const applyPendingGoto = useCallback(() => {
      const view = cmRef.current?.view;
      const line = pendingLineRef.current;
      if (!view || line == null || statusRef.current !== "ready") return;
      const target = Math.max(1, Math.min(line, view.state.doc.lines));
      const at = view.state.doc.line(target).from;
      view.dispatch({
        selection: { anchor: at },
        effects: EditorView.scrollIntoView(at, { y: "center" }),
      });
      view.focus();
      pendingLineRef.current = null;
    }, []);

    useEffect(() => {
      if (doc.status === "ready") applyPendingGoto();
    }, [doc.status, applyPendingGoto]);

    useEffect(() => {
      if (
        doc.status !== "ready" ||
        initialSourceLine == null ||
        restoredSourceLineRef.current === initialSourceLine
      )
        return;
      const frame = requestAnimationFrame(() => {
        const view = cmRef.current?.view;
        if (!view) return;
        restoredSourceLineRef.current = initialSourceLine;
        restoreEditorSourceLine(view, initialSourceLine);
        viewportLineChangeRef.current?.(editorViewportSourceLine(view));
      });
      return () => cancelAnimationFrame(frame);
    }, [doc.status, initialSourceLine]);

    const extensions = useMemo(
      () => [
        // basicSetup is added before user extensions by @uiw/react-codemirror,
        // so we must elevate vim's precedence to win the keymap.
        vimCompartment.of(
          usePreferencesStore.getState().vimMode ? Prec.highest(vim()) : [],
        ),
        wrapCompartment.of(
          usePreferencesStore.getState().editorWordWrap
            ? EditorView.lineWrapping
            : [],
        ),
        vimHandlersExtension(() => ({
          save: () => {
            void performSaveRef.current();
          },
          close: () => onCloseRef.current?.(),
        })),
        ...buildSharedExtensions(),
        gitChangeGutter,
        indentCompartment.of(DEFAULT_INDENT),
        languageCompartment.of([]),
        lspCompartment.of([]),
        diagnosticsReporter(
          () => pathRef.current,
          () => diagnosticsOwnerId,
          () => lspActiveRef.current,
        ),
        EditorView.updateListener.of((update) => {
          if (!update.viewportChanged && !update.geometryChanged) return;
          viewportLineChangeRef.current?.(
            editorViewportSourceLine(update.view),
          );
        }),
        // Before inlineCompletion so an open popup wins Tab over the ghost.
        Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }])),
        inlineCompletion({
          getPrefs: () => {
            const s = usePreferencesStore.getState();
            const p = s.autocompleteProvider;
            // autocompleteModelId holds the compat- id of the chosen endpoint.
            const compatEp =
              p === "openai-compatible"
                ? s.customEndpoints.find(
                    (e) =>
                      e.id === endpointIdFromCompatModel(s.autocompleteModelId),
                  )
                : undefined;
            const modelId =
              p === "lmstudio"
                ? s.lmstudioModelId
                : p === "mlx"
                  ? s.mlxModelId
                  : p === "ollama"
                    ? s.ollamaModelId
                    : p === "openai-compatible"
                      ? (compatEp?.modelId ?? "")
                      : p === "openrouter"
                        ? s.openrouterModelId
                        : s.autocompleteModelId;
            return {
              enabled: s.autocompleteEnabled,
              trigger: s.autocompleteTrigger,
              provider: p,
              modelId,
              apiKey: apiKeyRef.current,
              lmstudioBaseURL: s.lmstudioBaseURL,
              mlxBaseURL: s.mlxBaseURL,
              ollamaBaseURL: s.ollamaBaseURL,
              openaiCompatibleBaseURL:
                compatEp?.baseURL ?? s.openaiCompatibleBaseURL,
            };
          },
          getPath: () => pathRef.current,
          getLanguage: () => languageRef.current,
        }),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              void performSaveRef.current();
              return true;
            },
          },
          { key: "Ctrl-g", run: gotoLine },
        ]),
      ],
      [diagnosticsOwnerId],
    );

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: vimCompartment.reconfigure(vimMode ? Prec.highest(vim()) : []),
      });
    }, [vimMode]);

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: wrapCompartment.reconfigure(
          editorWordWrap ? EditorView.lineWrapping : [],
        ),
      });
    }, [editorWordWrap]);

    useEffect(() => {
      if (doc.status !== "ready") return;
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: indentCompartment.reconfigure(
          indentExtension(detectIndentUnit(baselineContent)),
        ),
      });
    }, [baselineContent, doc.status]);

    // A shared document can have several CodeMirror views. Only the focused
    // view may own LSP synchronization, otherwise the same URI is opened and
    // versioned independently by every view.
    const lspExt = useLspExtension(
      path,
      langId,
      doc.status === "ready" && lspEnabled,
    );
    useEffect(() => {
      lspActiveRef.current = lspExt !== null;
      if (lspExt) {
        useDiagnosticsStore.getState().claim(path, diagnosticsOwnerId);
      }
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: lspCompartment.reconfigure(lspExt ?? []),
      });
    }, [diagnosticsOwnerId, lspExt, path]);

    useEffect(
      () => () =>
        useDiagnosticsStore.getState().clear(path, diagnosticsOwnerId),
      [diagnosticsOwnerId, path],
    );

    // Warm the language chunk while the file is still being read; the
    // ready-gated effect below then resolves from cache.
    useEffect(() => {
      const resolvePath = overrideLanguage ? `dummy.${overrideLanguage}` : path;
      void resolveLanguage(resolvePath).catch(() => {});
    }, [path, overrideLanguage]);

    const documentSize = doc.status === "ready" ? doc.size : null;

    useEffect(() => {
      const ext =
        overrideLanguage || (path.split(".").pop()?.toLowerCase() ?? null);
      languageRef.current = ext;
      if (doc.status !== "ready") return;
      if (documentSize !== null && documentSize > SYNTAX_MAX_BYTES) {
        setLangId(null);
        const view = cmRef.current?.view;
        view?.dispatch({ effects: languageCompartment.reconfigure([]) });
        return;
      }
      let cancelled = false;
      const resolve = async (): Promise<LanguageResult> => {
        const resolvePath = overrideLanguage
          ? `dummy.${overrideLanguage}`
          : path;
        return (
          (await resolveLanguage(resolvePath)) ?? {
            ext: [],
            name: "",
            id: "",
          }
        );
      };
      void resolve().then((result) => {
        if (cancelled) return;
        if (result.id) languageRef.current = result.id;
        setLangId(result.id || ext);
        const view = cmRef.current?.view;
        if (!view) return;
        view.dispatch({
          effects: languageCompartment.reconfigure(result.ext),
        });
      });
      return () => {
        cancelled = true;
      };
    }, [path, doc.status, overrideLanguage, documentSize]);

    useImperativeHandle(
      ref,
      () => ({
        open: () => {
          const view = cmRef.current?.view;
          if (!view) return;
          openEditorFindPanel(view);
        },
        focus: () => {
          cmRef.current?.view?.focus();
        },
        getSelection: () => {
          const view = cmRef.current?.view;
          if (!view) return null;
          const { from, to } = view.state.selection.main;
          if (from === to) return null;
          return view.state.sliceDoc(from, to);
        },
        getPath: () => path,
        getViewportSourceLine: () => {
          const view = cmRef.current?.view;
          return view ? editorViewportSourceLine(view) : null;
        },
        reload: () => reloadRef.current(),
        gotoLine: (line: number) => {
          pendingLineRef.current = line;
          applyPendingGoto();
        },
        scrollToSourceLine: (line: number) => {
          const view = cmRef.current?.view;
          if (!view) return;
          restoreEditorSourceLine(view, line);
          view.focus();
          requestAnimationFrame(() => {
            viewportLineChangeRef.current?.(editorViewportSourceLine(view));
          });
        },
        undo: () => {
          const view = cmRef.current?.view;
          if (view) undo(view);
        },
        redo: () => {
          const view = cmRef.current?.view;
          if (view) redo(view);
        },
        triggerAiComplete: () => {
          const view = cmRef.current?.view;
          if (view) triggerInlineCompletion(view);
        },
        triggerCodeComplete: () => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.focus();
          startCompletion(view);
        },
      }),
      [path, applyPendingGoto],
    );

    const previewKind = previewMediaKind(path);
    const previewEnabled =
      previewKind !== null &&
      (doc.status === "binary" ||
        (doc.status === "toolarge" && workspace.kind !== "ssh"));
    const previewAsset = usePreviewAssetUrl(path, workspace, previewEnabled);

    if (doc.status === "loading") {
      return (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          {t("common:loading")}
        </div>
      );
    }
    if (doc.status === "error") {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs text-destructive">
          {doc.message}
        </div>
      );
    }
    if (doc.status === "binary" || doc.status === "toolarge") {
      if (previewEnabled) {
        if (previewAsset.error) {
          return (
            <div className="flex h-full items-center justify-center px-6 text-center text-xs text-destructive">
              {previewAsset.error}
            </div>
          );
        }
        if (!previewAsset.url) {
          return (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {t("common:loading")}
            </div>
          );
        }
        return (
          <div className="app-scrollbar flex h-full min-h-0 flex-col items-center justify-center bg-background p-4 overflow-auto">
            {previewKind === "image" && (
              <img
                src={previewAsset.url}
                loading="lazy"
                decoding="async"
                className="max-w-full max-h-full object-contain rounded-md border border-border shadow-sm"
                style={{
                  backgroundImage:
                    "conic-gradient(var(--muted) 0.25turn, transparent 0.25turn 0.5turn, var(--muted) 0.5turn 0.75turn, transparent 0.75turn)",
                  backgroundSize: "20px 20px",
                }}
                alt={path.split("/").pop()}
              />
            )}
            {previewKind === "video" && (
              // biome-ignore lint/a11y/useMediaCaption: local media preview opens arbitrary files with no caption track
              <video
                controls
                preload="metadata"
                className="max-w-full max-h-full"
                src={previewAsset.url}
              />
            )}
            {previewKind === "audio" && (
              // biome-ignore lint/a11y/useMediaCaption: local media preview opens arbitrary files with no caption track
              <audio
                controls
                preload="metadata"
                className="w-full max-w-md"
                src={previewAsset.url}
              />
            )}
            {previewKind === "pdf" && (
              <iframe
                src={previewAsset.url}
                className="w-full h-full border-none"
                title={path.split("/").pop()}
              />
            )}
          </div>
        );
      }

      const canForce =
        doc.status === "toolarge" && doc.size <= FORCE_READ_LIMIT;
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <div className="text-sm text-foreground">
            {doc.status === "binary" ? t("binaryFile") : t("fileTooLarge")}
          </div>
          <div className="text-xs text-muted-foreground">
            {formatBytes(doc.size)} ·{" "}
            {canForce ? t("syntaxFeaturesDisabled") : t("previewNotSupported")}
          </div>
          {canForce && (
            <button
              type="button"
              onClick={openAnyway}
              className="mt-2 rounded-md border border-border bg-muted/60 px-3 py-1 text-xs text-foreground hover:bg-accent"
            >
              Open anyway
            </button>
          )}
        </div>
      );
    }

    return (
      <div className="flex h-full min-h-0 flex-col zoom-exempt">
        <CodeMirror
          ref={cmRef}
          value={doc.content}
          onChange={onChange}
          theme={themeExt}
          extensions={extensions}
          height="100%"
          className="flex-1 min-h-0 overflow-hidden"
          basicSetup={{
            lineNumbers: true,
            highlightActiveLineGutter: true,
            foldGutter: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            highlightActiveLine: true,
            highlightSelectionMatches: true,
            searchKeymap: true,
          }}
        />
      </div>
    );
  }),
);

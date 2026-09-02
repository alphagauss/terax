/**
 * 本文件实现 CodeMirror 编辑器面板及其保存、格式化、语言服务和预览交互。
 *
 * 负责将共享文档模型连接到编辑器视图。保存失败必须向用户提示，不能静默丢失远程写入错误。
 */

import i18n from "@/i18n";
import {
  DEFAULT_MODEL_REF,
  modelRefsEqual,
  resolveModel,
  tryResolveModel,
} from "@/modules/ai/config";
import { getKey, getProviderInstanceKey } from "@/modules/ai/lib/keyring";
import type { FindHandle } from "@/modules/find";
import { lspFormatDocument, useLspExtension } from "@/modules/lsp";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { onKeysChanged } from "@/modules/settings/store";
import { matchBinding, SHORTCUTS } from "@/modules/shortcuts/shortcuts";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { acceptCompletion, startCompletion } from "@codemirror/autocomplete";
import { redo, undo } from "@codemirror/commands";
import { gotoLine } from "@codemirror/search";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
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
import { openEditorFindPanel } from "./lib/find/editorFindPanel";
import { gitChangeGutter, setQuickDiffBaseline } from "./lib/gitGutter";
import { detectIndentUnit } from "./lib/indent";
import { type LanguageResult, resolveLanguage } from "./lib/languageResolver";
import {
  type EditorDocument,
  FORCE_READ_LIMIT,
  useDocument,
} from "./lib/useDocument";
import { useEditorThemeExt } from "./lib/useEditorThemeExt";
import { previewMediaKind, usePreviewAssetUrl } from "./lib/usePreviewAssetUrl";
import { useVimExtension } from "./lib/useVimExtension";
import { vimHandlersExtension } from "./lib/vimHandlers";

/** 编辑器源码行内的 UTF-16 选区。 */
export type EditorSourceSelection = {
  start: number;
  end: number;
};

export type EditorPaneHandle = FindHandle & {
  focus: () => void;
  getSelection: () => string | null;
  getPath: () => string;
  /** 保存当前缓冲区，发生保存冲突或写入失败时返回 false。 */
  save: () => Promise<boolean>;
  /** 从磁盘重新读取并与当前缓冲区协调，不直接覆盖未保存内容。 */
  reload: () => void;
  /** 先核对数据源端版本，只有内容变化时才读取正文。 */
  checkForChanges: () => void;
  /** 内容就绪后跳到从一开始计数的行，并可选中该行内的 UTF-16 区间。 */
  gotoLine: (line: number, selection?: EditorSourceSelection) => void;
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

export type EditorPaneProps = {
  path: string;
  remotePollingActive?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
  onClose?: () => void;
  lspEnabled?: boolean;
  initialSourceLine?: number | null;
  onViewportSourceLineChange?: (line: number) => void;
};

type Props = EditorPaneProps;

type CoreProps = Omit<Props, "onDirtyChange"> & {
  document: EditorDocument;
};

// Above this, syntax highlighting and LSP are disabled: a multi-MB lezer
// parse tree and a didOpen of that size cost far more than they give.
const SYNTAX_MAX_BYTES = 4 * 1024 * 1024;
const VIEWPORT_SOURCE_LINE_OFFSET = 32;
const TEMPORARY_WORD_WRAP_SHORTCUT = SHORTCUTS.find(
  (shortcut) => shortcut.id === "editor.toggleWordWrap",
);

/** 判断键盘事件是否匹配用户为临时自动换行设置的绑定。 */
function matchesTemporaryWordWrapShortcut(event: KeyboardEvent): boolean {
  const bindings =
    usePreferencesStore.getState().shortcuts["editor.toggleWordWrap"] ??
    TEMPORARY_WORD_WRAP_SHORTCUT?.defaultBindings ??
    [];
  return bindings.some((binding) =>
    matchBinding(event, binding, "editor.toggleWordWrap"),
  );
}

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
 * 为独立调用方订阅共享文档，再交给已加载的 CodeMirror 面板渲染。
 */
export const EditorPane = memo(
  forwardRef<EditorPaneHandle, Props>(function EditorPane(props, ref) {
    const { onDirtyChange, ...coreProps } = props;
    const document = useDocument({
      path: props.path,
      active: props.remotePollingActive,
      onDirtyChange,
    });
    return <EditorCore {...coreProps} ref={ref} document={document} />;
  }),
);

/**
 * 已取得共享文档的 CodeMirror 面板。
 *
 * 负责编辑、保存、格式化和渐进启用语言服务，不再触发文件首次读取。
 */
export const EditorCore = memo(
  forwardRef<EditorPaneHandle, CoreProps>(function EditorCore(props, ref) {
    const { t } = useTranslation("editor");
    const diagnosticsOwnerId = useId();
    const {
      path,
      onSaved,
      onClose,
      lspEnabled = true,
      initialSourceLine,
      onViewportSourceLineChange,
      document,
    } = props;

    const {
      doc,
      baselineContent,
      gitBaseline,
      onChange,
      save,
      reload,
      checkForChanges,
      adoptFormattedDiskText,
      openAnyway,
    } = document;
    const reloadRef = useRef(reload);
    reloadRef.current = reload;
    const checkForChangesRef = useRef(checkForChanges);
    checkForChangesRef.current = checkForChanges;
    const adoptFormattedDiskTextRef = useRef(adoptFormattedDiskText);
    adoptFormattedDiskTextRef.current = adoptFormattedDiskText;
    const cmRef = useRef<ReactCodeMirrorRef>(null);
    const editorContainerRef = useRef<HTMLDivElement>(null);
    const viewportLineChangeRef = useRef(onViewportSourceLineChange);
    viewportLineChangeRef.current = onViewportSourceLineChange;
    const themeExt = useEditorThemeExt();
    const vimMode = usePreferencesStore((s) => s.vimMode);
    const vimExtension = useVimExtension(vimMode);
    const editorWordWrap = usePreferencesStore((s) => s.editorWordWrap);
    // 覆盖值只存在于当前编辑器视图，关闭后不影响全局偏好或其他文件。
    const [temporaryWordWrap, setTemporaryWordWrap] = useState<boolean | null>(
      null,
    );
    const workspace = useWorkspaceEnvStore((s) => s.env);
    const languageRef = useRef<string | null>(null);
    const [langId, setLangId] = useState<string | null>(null);
    const apiKeyRef = useRef<string | null>(null);

    /** 切换当前编辑器视图的自动换行，不持久化到偏好设置。 */
    const toggleTemporaryWordWrap = useCallback(() => {
      setTemporaryWordWrap(
        (current) =>
          !(current ?? usePreferencesStore.getState().editorWordWrap),
      );
    }, []);
    const toggleTemporaryWordWrapRef = useRef(toggleTemporaryWordWrap);
    toggleTemporaryWordWrapRef.current = toggleTemporaryWordWrap;

    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent) => {
        if (
          event.isComposing ||
          event.keyCode === 229 ||
          !editorContainerRef.current?.matches(":hover") ||
          !matchesTemporaryWordWrapShortcut(event)
        )
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleTemporaryWordWrapRef.current();
      };
      window.addEventListener("keydown", onKeyDown, { capture: true });
      return () =>
        window.removeEventListener("keydown", onKeyDown, { capture: true });
    }, []);

    useEffect(() => {
      let cancelled = false;
      const refresh = async () => {
        const s = usePreferencesStore.getState();
        const model = tryResolveModel(s.autocompleteModel, s.customProviders);
        if (!model) {
          apiKeyRef.current = null;
          return;
        }
        const provider = model.provider;
        if (
          provider === "lmstudio" ||
          provider === "mlx" ||
          provider === "ollama"
        ) {
          apiKeyRef.current = null;
          return;
        }
        if (
          s.customProviders.some(
            (providerInstance) => providerInstance.id === model.providerId,
          )
        ) {
          const k = await getProviderInstanceKey(model.providerId);
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
          !modelRefsEqual(state.autocompleteModel, prev.autocompleteModel) ||
          state.customProviders !== prev.customProviders
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
    // identity; a new identity makes @uiw/react-codemirror reconfigure the
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

    /** 保存当前编辑器缓冲区，并在成功落盘后执行配置的外部格式化。 */
    const performSave = useCallback(async (): Promise<boolean> => {
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
        return false;
      }
      if (!saved) return false;
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
              adoptFormattedDiskTextRef.current(
                readBack.text,
                readBack.revision,
                readBack.size,
                readBack.mtime,
              ),
            );
          }
        }
      }
      onSavedRef.current?.();
      return true;
    }, []);
    const performSaveRef = useRef(performSave);
    performSaveRef.current = performSave;

    const pathRef = useRef(path);
    pathRef.current = path;
    useEffect(() => {
      if (doc.status !== "ready") return;
      let cancelled = false;
      let frame = 0;
      const run = () => {
        const view = cmRef.current?.view;
        if (!view) {
          frame = requestAnimationFrame(run);
          return;
        }
        if (!cancelled && view.dom.isConnected) {
          view.dispatch({ effects: setQuickDiffBaseline.of(gitBaseline) });
        }
      };
      run();
      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
      };
    }, [doc.status, gitBaseline]);

    const pendingLineRef = useRef<{
      line: number;
      selection?: EditorSourceSelection;
    } | null>(null);
    const pendingGotoFrameRef = useRef(0);
    const restoredSourceLineRef = useRef<number | null>(null);
    const statusRef = useRef(doc.status);
    statusRef.current = doc.status;

    /** 在内容就绪后应用跳转和可选搜索选区，避免新标签挂载时丢失定位。 */
    const applyPendingGoto = useCallback((): boolean => {
      const view = cmRef.current?.view;
      const pending = pendingLineRef.current;
      if (!pending) return true;
      if (!view || statusRef.current !== "ready") return false;
      const target = Math.max(1, Math.min(pending.line, view.state.doc.lines));
      const line = view.state.doc.line(target);
      const start = Math.max(
        0,
        Math.min(pending.selection?.start ?? 0, line.length),
      );
      const end = Math.max(
        start,
        Math.min(pending.selection?.end ?? start, line.length),
      );
      const from = line.from + start;
      view.dispatch({
        selection: { anchor: from, head: line.from + end },
        effects: EditorView.scrollIntoView(from, { y: "center" }),
      });
      view.focus();
      pendingLineRef.current = null;
      return true;
    }, []);

    /** 等待文档与 CodeMirror 同时就绪后再消费定位，覆盖首次挂载和 Markdown 懒加载。 */
    const schedulePendingGoto = useCallback(() => {
      if (pendingGotoFrameRef.current) return;
      const run = () => {
        pendingGotoFrameRef.current = 0;
        if (applyPendingGoto()) return;
        if (statusRef.current !== "loading" && statusRef.current !== "ready") {
          pendingLineRef.current = null;
          return;
        }
        pendingGotoFrameRef.current = requestAnimationFrame(run);
      };
      run();
    }, [applyPendingGoto]);

    useEffect(() => {
      if (doc.status === "ready") schedulePendingGoto();
    }, [doc.status, schedulePendingGoto]);

    useEffect(
      () => () => cancelAnimationFrame(pendingGotoFrameRef.current),
      [],
    );

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
        vimCompartment.of([]),
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
        EditorView.domEventHandlers({
          keydown: (event) => {
            if (!matchesTemporaryWordWrapShortcut(event)) return false;
            event.preventDefault();
            toggleTemporaryWordWrapRef.current();
            return true;
          },
        }),
        // Before inlineCompletion so an open popup wins Tab over the ghost.
        Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }])),
        inlineCompletion({
          getPrefs: () => {
            const s = usePreferencesStore.getState();
            const configuredModel = tryResolveModel(
              s.autocompleteModel,
              s.customProviders,
            );
            const model = configuredModel ?? resolveModel(DEFAULT_MODEL_REF);
            return {
              enabled: s.autocompleteEnabled && !!configuredModel,
              trigger: s.autocompleteTrigger,
              provider: model.provider,
              modelId: model.id,
              apiKey: apiKeyRef.current,
              lmstudioBaseURL: s.lmstudioBaseURL,
              mlxBaseURL: s.mlxBaseURL,
              ollamaBaseURL: s.ollamaBaseURL,
              openaiCompatibleBaseURL: model.baseURL,
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
        effects: vimCompartment.reconfigure(
          vimExtension ? Prec.highest(vimExtension) : [],
        ),
      });
    }, [vimExtension]);

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: wrapCompartment.reconfigure(
          (temporaryWordWrap ?? editorWordWrap) ? EditorView.lineWrapping : [],
        ),
      });
    }, [editorWordWrap, temporaryWordWrap]);

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

    const documentSize = doc.status === "ready" ? doc.size : null;

    useEffect(() => {
      const ext = path.split(".").pop()?.toLowerCase() ?? null;
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
        return (
          (await resolveLanguage(path)) ?? {
            ext: [],
            name: "",
            id: "",
          }
        );
      };
      // 先让无高亮的 CodeMirror 完成首帧，再下载并接入对应语言扩展。
      const frame = requestAnimationFrame(() => {
        void resolve()
          .then((result) => {
            if (cancelled) return;
            if (result.id) languageRef.current = result.id;
            setLangId(result.id || ext);
            const view = cmRef.current?.view;
            if (!view) return;
            view.dispatch({
              effects: languageCompartment.reconfigure(result.ext),
            });
          })
          .catch((error) => {
            if (!cancelled) {
              console.warn("[editor] language extension load failed", error);
            }
          });
      });
      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
      };
    }, [path, doc.status, documentSize]);

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
        save: () => performSaveRef.current(),
        getViewportSourceLine: () => {
          const view = cmRef.current?.view;
          return view ? editorViewportSourceLine(view) : null;
        },
        reload: () => reloadRef.current(),
        checkForChanges: () => checkForChangesRef.current(),
        gotoLine: (line: number, selection?: EditorSourceSelection) => {
          pendingLineRef.current = { line, selection };
          schedulePendingGoto();
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
      [path, schedulePendingGoto],
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
      <div
        ref={editorContainerRef}
        className="flex h-full min-h-0 flex-col zoom-exempt"
      >
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

/**
 * 本文件渲染块终端的独立 Shell 输入控件。
 * 输入草稿与焦点状态按终端 ID 隔离，提交仍写入对应 PTY。
 */

import {
  readTerminalClipboard,
  writeTerminalClipboard,
} from "@/modules/terminal/lib/terminalClipboard";
import { FileDropOutline } from "@/components/controls/file-drop-outline";
import { useTerminalDropStore } from "@/modules/terminal/lib/dropStore";
import { resolveFontFamily } from "@/lib/fonts";
import { IS_MAC } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  clearTerminalBlockSelection,
  getTerminalDraft,
  terminalGridSelection,
  terminalUsesPowerShell,
  setTerminalDraft,
  setTerminalInputActivity,
  setTerminalInputFocus,
  setTerminalInputPaste,
} from "../lib/useTerminalSession";
import {
  historyCommands,
  historyList,
  historyRecord,
  historySuggest,
} from "./lib/history";
import type { BlockMode } from "./lib/modeMachine";
import { createShellEditor, type ShellEditorHandle } from "./lib/shellEditor";

type Props = {
  /** 输入栏当前控制的终端，编辑器会随之重新绑定。 */
  terminalId: number;
  mode: BlockMode;
  focused: boolean;
  /** Changes when the active theme changes, so the editor re-themes. */
  themeKey: string;
  onSubmit: (text: string) => Promise<boolean>;
  onInterrupt: () => void;
  getCwd: () => string | null;
};

/** 渲染块终端输入框并同步该终端的草稿和选择状态。 */
export default function ShellInput({
  terminalId,
  mode,
  focused,
  themeKey,
  onSubmit,
  onInterrupt,
  getCwd,
}: Props) {
  const { t } = useTranslation("terminal");
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<ShellEditorHandle | null>(null);
  const commandsRef = useRef<string[]>([]);
  const cbRef = useRef({ onSubmit, onInterrupt, getCwd });
  cbRef.current = { onSubmit, onInterrupt, getCwd };
  const terminalIdRef = useRef(terminalId);
  terminalIdRef.current = terminalId;
  const atPrompt = mode === "prompt";
  const focusableRef = useRef(false);
  focusableRef.current = focused && atPrompt;

  useEffect(() => {
    let alive = true;
    historyCommands("", 2000).then((cmds) => {
      if (alive) commandsRef.current = cmds;
    });
    return () => {
      alive = false;
    };
  }, []);

  const fontFamilyPref = usePreferencesStore((p) => p.terminalFontFamily);
  const fontSize = usePreferencesStore((p) => p.terminalFontSize);
  const fontFamily = resolveFontFamily(fontFamilyPref);
  const fontRef = useRef({ fontFamily, fontSize });
  fontRef.current = { fontFamily, fontSize };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = createShellEditor({
      parent: host,
      fontFamily: fontRef.current.fontFamily,
      fontSize: fontRef.current.fontSize,
      commandNames: () => commandsRef.current,
      getCwd: () => cbRef.current.getCwd(),
      isPowerShell: () => terminalUsesPowerShell(terminalIdRef.current),
      onChange: (text) =>
        setTerminalInputActivity(terminalIdRef.current, text.length > 0),
      suggest: historySuggest,
      historyList,
      onSubmit: async (text) => {
        const id = terminalIdRef.current;
        if (!(await cbRef.current.onSubmit(text))) return false;
        historyRecord(text);
        const first = text.trim().split(/\s+/)[0];
        if (first && !commandsRef.current.includes(first)) {
          commandsRef.current = [first, ...commandsRef.current];
        }
        if (getTerminalDraft(id) === text) setTerminalDraft(id, "");
        return terminalIdRef.current === id;
      },
      onInterrupt: () => cbRef.current.onInterrupt(),
      copySelectionOnCtrlC: () =>
        !IS_MAC && usePreferencesStore.getState().terminalSmartCopyPaste,
      onEscape: () => clearTerminalBlockSelection(terminalIdRef.current),
    });
    handleRef.current = handle;
    return () => {
      handle.destroy();
      handleRef.current = null;
    };
  }, []);

  const insertText = useCallback((text: string): boolean => {
    const view = handleRef.current?.view;
    if (!text || !view || !focusableRef.current) return false;
    view.dispatch({
      ...view.state.replaceSelection(text),
      userEvent: "input.paste",
      scrollIntoView: true,
    });
    view.focus();
    return true;
  }, []);

  // 单个编辑器随活动终端切换焦点回调和草稿，使每个终端保留各自未发送的命令。
  // 新建或切换标签后，光标直接落入输入框。
  useEffect(() => {
    setTerminalInputFocus(terminalId, () => handleRef.current?.focus());
    setTerminalInputPaste(
      terminalId,
      (text) => terminalIdRef.current === terminalId && insertText(text),
    );
    handleRef.current?.setValue(getTerminalDraft(terminalId));
    requestAnimationFrame(() => {
      if (focusableRef.current && terminalIdRef.current === terminalId) {
        handleRef.current?.focus();
      }
    });
    return () => {
      const value = handleRef.current?.getValue() ?? "";
      setTerminalDraft(terminalId, value);
      setTerminalInputActivity(terminalId, value.length > 0);
      setTerminalInputFocus(terminalId, null);
      setTerminalInputPaste(terminalId, null);
    };
  }, [terminalId, insertText]);

  useEffect(() => {
    void themeKey;
    handleRef.current?.retheme(fontFamily, fontSize);
  }, [fontFamily, fontSize, themeKey]);

  useEffect(() => {
    handleRef.current?.setPlaceholder(t("block.inputPlaceholder"));
  }, [t]);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    handle.setEditable(atPrompt);
    if (atPrompt && focusableRef.current) handle.focus();
  }, [atPrompt]);

  useEffect(() => {
    if (focused && atPrompt) handleRef.current?.focus();
  }, [focused, atPrompt]);

  // 输入框持有焦点时，终端网格选区仍走原生复制；编辑器自身选区由编辑器处理。
  const onCopyCapture = (e: React.ClipboardEvent) => {
    const view = handleRef.current?.view;
    if (view?.state.selection.ranges.some((range) => !range.empty)) return;
    const sel = terminalGridSelection(terminalId);
    if (!sel) return;
    e.preventDefault();
    e.stopPropagation();
    void writeTerminalClipboard(sel);
  };

  const dropActive = useTerminalDropStore(
    (state) =>
      state.targetTerminalId === terminalId && state.targetSurface === "input",
  );
  const pasteClipboard = async () => {
    const id = terminalIdRef.current;
    const text = await readTerminalClipboard();
    if (id === terminalIdRef.current) insertText(text);
  };

  return (
    <div
      className={cn(
        "relative flex items-start gap-2",
        !atPrompt && "opacity-45",
      )}
      data-terminal-id={atPrompt ? terminalId : undefined}
      data-terminal-drop-surface="input"
      onKeyDownCapture={(event) => {
        if (!atPrompt || event.altKey) return;
        if (
          ((event.metaKey || event.ctrlKey) &&
            (event.code === "KeyV" || event.key.toLowerCase() === "v")) ||
          (event.shiftKey && event.key === "Insert")
        ) {
          event.preventDefault();
          event.stopPropagation();
          void pasteClipboard();
        }
      }}
      onPasteCapture={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (atPrompt) void pasteClipboard();
      }}
      onCopyCapture={onCopyCapture}
    >
      {dropActive ? <FileDropOutline /> : null}
      <span
        className="select-none pt-px text-primary/80"
        style={{ fontFamily, fontSize: `${fontSize}px`, lineHeight: 1.5 }}
      >
        ❯
      </span>
      <div ref={hostRef} className="min-w-0 flex-1" />
    </div>
  );
}

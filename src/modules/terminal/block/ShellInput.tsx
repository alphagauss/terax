/**
 * 本文件渲染块终端的独立 Shell 输入控件。
 * 输入草稿与焦点状态按终端 ID 隔离，提交仍写入对应 PTY。
 */

import { resolveFontFamily } from "@/lib/fonts";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useEffect, useRef } from "react";
import {
  clearTerminalBlockSelection,
  getTerminalDraft,
  terminalGridSelection,
  setTerminalDraft,
  setTerminalInputActivity,
  setTerminalInputFocus,
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
  onSubmit: (text: string) => void;
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
      placeholderText: `Run a command  -  ↑ history  ${fmtShortcut(MOD_KEY, "U")} switch to AI`,
      commandNames: () => commandsRef.current,
      getCwd: () => cbRef.current.getCwd(),
      onChange: (text) =>
        setTerminalInputActivity(terminalIdRef.current, text.length > 0),
      suggest: historySuggest,
      historyList,
      onSubmit: (text) => {
        historyRecord(text);
        const first = text.trim().split(/\s+/)[0];
        if (first && !commandsRef.current.includes(first)) {
          commandsRef.current = [first, ...commandsRef.current];
        }
        cbRef.current.onSubmit(text);
      },
      onInterrupt: () => cbRef.current.onInterrupt(),
      onEscape: () => clearTerminalBlockSelection(terminalIdRef.current),
    });
    handleRef.current = handle;
    requestAnimationFrame(() => handleRef.current?.focus());
    return () => {
      handle.destroy();
      handleRef.current = null;
    };
  }, []);

  // 单个编辑器随活动终端切换焦点回调和草稿，使每个终端保留各自未发送的命令。
  // 新建或切换标签后，光标直接落入输入框。
  useEffect(() => {
    setTerminalInputFocus(terminalId, () => handleRef.current?.focus());
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
    };
  }, [terminalId]);

  useEffect(() => {
    void themeKey;
    handleRef.current?.retheme(fontFamily, fontSize);
  }, [fontFamily, fontSize, themeKey]);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    handle.setEditable(atPrompt);
    if (atPrompt) handle.focus();
  }, [atPrompt]);

  useEffect(() => {
    if (focused && atPrompt) handleRef.current?.focus();
  }, [focused, atPrompt]);

  // The editor holds focus at the prompt, so a Cmd+C over a grid selection lands
  // here, not on the xterm. Copy the grid selection unless the editor has its own.
  const onCopyCapture = (e: React.ClipboardEvent) => {
    const view = handleRef.current?.view;
    if (view && !view.state.selection.main.empty) return;
    const sel = terminalGridSelection(terminalId);
    if (!sel) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", sel);
  };

  return (
    <div
      className={cn("flex items-start gap-2", !atPrompt && "opacity-45")}
      onCopyCapture={onCopyCapture}
    >
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

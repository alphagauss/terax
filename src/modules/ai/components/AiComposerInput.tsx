/**
 * 本文件实现 Agent Composer 的文本输入和触发器选择。
 *
 * 负责命令、片段、文件提示与剪贴板附件，不持久化 Composer 状态。
 */

import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { usePresence } from "@/lib/usePresence";
import { cn } from "@/lib/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseExternalAgentBinding } from "../external-agents/runtime";
import { useComposerClipboard } from "@/modules/ai/hooks/useComposerClipboard";
import { useComposer } from "../lib/composer";
import { filterOpenFileGroups } from "@/modules/ai/lib/openFileCandidates";
import { availableCommands } from "@/modules/ai/commands/registry";
import { sessionMetadata, useChatStore } from "../store/chatStore";
import { useSnippetsStore } from "../store/snippetsStore";
import { FilePickerContent } from "./FilePicker";
import { type PickerItem, SnippetPickerContent } from "./SnippetPicker";

type SnippetTrigger = {
  start: number;
  end: number;
  query: string;
  char: "#" | "/";
};

type FileTrigger = {
  start: number;
  end: number;
  query: string;
};

function detectSnippetTrigger(
  value: string,
  caret: number,
): SnippetTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "#" || ch === "/") {
      const prev = i === 0 ? " " : value[i - 1];
      if (!/\s/.test(prev) || (ch === "/" && value.slice(0, i).trim()))
        return null;
      const slice = value.slice(i + 1, caret);
      if (!/^[a-z0-9-]*$/i.test(slice)) return null;
      return { start: i, end: caret, query: slice.toLowerCase(), char: ch };
    }
    if (/\s/.test(ch)) return null;
    if (!/[a-z0-9-]/i.test(ch)) return null;
  }
  return null;
}

function detectFileTrigger(value: string, caret: number): FileTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "@") {
      const prev = i === 0 ? " " : value[i - 1];
      if (!/\s/.test(prev)) return null;
      const slice = value.slice(i + 1, caret);
      return { start: i, end: caret, query: slice };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

/**
 * Agent 主输入框。
 *
 * 除键盘触发器外，系统文件与内存图片粘贴复用 Composer 的标准附件流程。
 */
export function AiComposerInput() {
  const { t } = useTranslation("ai");
  const c = useComposer();
  const clipboard = useComposerClipboard(c);
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const draftSessionId = useChatStore((state) => state.draftSessionId);
  const draftExternalAgentId = useChatStore(
    (state) => state.draftExternalAgentId,
  );
  const usesExternalAgent = Boolean(
    parseExternalAgentBinding(
      activeSessionId ? sessionMetadata.get(activeSessionId) : undefined,
    ) ?? (activeSessionId === draftSessionId ? draftExternalAgentId : null),
  );
  const focusSignal = useChatStore((s) => s.focusSignal);
  const snippets = useSnippetsStore((s) => s.snippets);
  useEffect(() => {
    if (focusSignal === 0) return;
    requestAnimationFrame(() => c.textareaRef.current?.focus());
  }, [c.textareaRef, focusSignal]);

  const [trigger, setTrigger] = useState<SnippetTrigger | null>(null);
  const [fileTrigger, setFileTrigger] = useState<FileTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    autoresize(c.textareaRef.current);
  }, [c.value, c.textareaRef]);

  const updateTrigger = () => {
    const el = c.textareaRef.current;
    if (!el) {
      setTrigger(null);
      setFileTrigger(null);
      return;
    }
    const caret = el.selectionStart ?? 0;
    setTrigger(detectSnippetTrigger(c.value, caret));
    setFileTrigger(detectFileTrigger(c.value, caret));
  };

  useEffect(updateTrigger, [c.value, c.textareaRef]);

  const filteredItems = useMemo<PickerItem[]>(() => {
    if (!trigger) return [];
    const q = trigger.query;
    const cmdItems: PickerItem[] = (
      usesExternalAgent ? [] : availableCommands({ kind: "desktop" })
    )
      .filter(
        (c) =>
          !q ||
          c.name.includes(q) ||
          c.aliases.some((alias) => alias.includes(q)) ||
          t(c.descriptionKey).toLowerCase().includes(q),
      )
      .map((command) => ({ kind: "command", command }));
    if (trigger.char === "/") return cmdItems;
    const snipItems: PickerItem[] = snippets
      .filter(
        (s) =>
          !q ||
          s.handle.includes(q) ||
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      )
      .map((snippet) => ({ kind: "snippet", snippet }));
    return snipItems;
  }, [trigger, snippets, usesExternalAgent, t]);

  const fileQuery = fileTrigger?.query ?? "";
  const filteredFileGroups = useMemo(
    () =>
      fileTrigger ? filterOpenFileGroups(c.openFileGroups, fileQuery) : [],
    [c.openFileGroups, fileQuery, fileTrigger],
  );
  const filteredFiles = useMemo(
    () => filteredFileGroups.flatMap((group) => group.files),
    [filteredFileGroups],
  );

  const fileTriggerOpen = fileTrigger !== null;
  const snippetTriggerOpen = trigger !== null;
  useEffect(() => {
    if (!fileTriggerOpen) return;
    const active = filteredFiles.findIndex((file) => file.active);
    setActiveIndex(active >= 0 ? active : 0);
  }, [fileTriggerOpen, filteredFiles]);
  useEffect(() => {
    if (snippetTriggerOpen) setActiveIndex(0);
  }, [snippetTriggerOpen]);

  const pickerOpen = trigger !== null || fileTrigger !== null;

  const onPickItem = (item: PickerItem) => {
    if (!trigger) return;
    const before = c.value.slice(0, trigger.start);
    const afterRaw = c.value.slice(trigger.end);
    let insert = "";
    if (item.kind === "snippet") {
      const needsSpace = afterRaw.length === 0 || !/^\s/.test(afterRaw);
      insert = `#${item.snippet.handle}${needsSpace ? " " : ""}`;
      c.addSnippet(item.snippet);
    } else {
      const text = `${before}/${item.command.name} ${afterRaw.trimStart()}`;
      c.setValue(text);
      c.submit(text);
      setTrigger(null);
      setActiveIndex(0);
      return;
    }
    c.setValue(`${before}${insert}${afterRaw}`);
    setTrigger(null);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      const el = c.textareaRef.current;
      if (!el) return;
      const caret = before.length + insert.length;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const onPickFile = async (filePath: string) => {
    if (!fileTrigger) return;
    const before = c.value.slice(0, fileTrigger.start);
    const after = c.value.slice(fileTrigger.end);
    c.setValue(`${before}${after}`);
    setFileTrigger(null);
    setActiveIndex(0);
    await c.attachFileByPath(filePath);
    requestAnimationFrame(() => {
      const el = c.textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  const pickActive = () => {
    if (fileTrigger) {
      const file = filteredFiles[activeIndex];
      if (file) void onPickFile(file.path);
      return;
    }
    const it = filteredItems[activeIndex];
    if (it) onPickItem(it);
  };

  const voiceLabel = c.voice.recording
    ? t("composer.listening")
    : c.voice.transcribing
      ? t("composer.transcribing")
      : null;
  const voiceRow = usePresence(Boolean(voiceLabel), 180);
  const lastVoiceLabel = useRef("");
  if (voiceLabel) lastVoiceLabel.current = voiceLabel;

  return (
    <>
      <Popover open={pickerOpen}>
        <PopoverAnchor asChild>
          <div className="flex items-start">
            <textarea
              ref={c.textareaRef}
              disabled={c.readOnly}
              value={c.readOnly ? "" : c.value}
              onChange={(e) => c.setValue(e.target.value)}
              onKeyUp={updateTrigger}
              onClick={updateTrigger}
              onSelect={updateTrigger}
              onPaste={clipboard.onPaste}
              onKeyDown={(e) => {
                clipboard.onKeyDown(e);
                if (pickerOpen) {
                  const items = fileTrigger ? filteredFiles : filteredItems;
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActiveIndex((i) =>
                      Math.min(i + 1, Math.max(0, items.length - 1)),
                    );
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActiveIndex((i) => Math.max(0, i - 1));
                    return;
                  }
                  if (e.key === "Tab" || e.key === "Enter") {
                    if (items.length > 0) {
                      e.preventDefault();
                      pickActive();
                      return;
                    }
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    if (fileTrigger) {
                      const before = c.value.slice(0, fileTrigger.start);
                      const after = c.value.slice(fileTrigger.end);
                      c.setValue(`${before}${after}`);
                      setFileTrigger(null);
                    } else {
                      setTrigger(null);
                    }
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  c.submit();
                }
              }}
              placeholder={
                c.readOnly
                  ? c.readOnlyEnvironmentKey
                    ? t("composer.foreignEnvironmentPlaceholder", {
                        environment: c.readOnlyEnvironmentKey,
                      })
                    : t("composer.channelReadOnly")
                  : t("composer.placeholder")
              }
              rows={1}
              className={cn(
                "max-h-40 flex-1 resize-none bg-transparent text-[13px] leading-relaxed outline-none",
                "placeholder:text-muted-foreground",
                "disabled:cursor-not-allowed",
              )}
            />
          </div>
        </PopoverAnchor>
        {fileTrigger ? (
          <FilePickerContent
            groups={filteredFileGroups}
            activeIndex={activeIndex}
            hasOpenFiles={c.openFileGroups.length > 0}
            onPick={(f) => void onPickFile(f)}
            onHover={setActiveIndex}
          />
        ) : (
          <SnippetPickerContent
            items={filteredItems}
            activeIndex={activeIndex}
            onPick={onPickItem}
            onHover={setActiveIndex}
          />
        )}
      </Popover>

      {voiceRow.mounted && (
        <div data-state={voiceRow.state} className="terax-reveal">
          <div className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
            {c.voice.recording ? (
              <span className="size-1.5 animate-pulse rounded-full bg-destructive" />
            ) : (
              <Spinner className="size-3" />
            )}
            <span className="truncate">
              {voiceLabel || lastVoiceLabel.current}
            </span>
          </div>
        </div>
      )}
    </>
  );
}

function autoresize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}

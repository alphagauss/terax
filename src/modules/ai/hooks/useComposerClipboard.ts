/** 文件粘贴优先保留原生路径；同一次快捷键和 DOM paste 共享读取，避免重复附件。 */
import {
  useEffect,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { readClipboardFiles } from "@/modules/file-actions/clipboard";
import { toast } from "sonner";
import { reportError } from "@/lib/errors";
import { useTranslation } from "react-i18next";
import { clipboardImageFiles } from "@/modules/ai/lib/clipboardImages";
import type { useComposer } from "@/modules/ai/lib/composer";
import { useChatStore } from "@/modules/ai/store/chatStore";

export function useComposerClipboard(composer: ReturnType<typeof useComposer>) {
  const { t } = useTranslation("ai");
  const current = useRef(composer);
  current.current = composer;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const gesture = useRef<{ files: Promise<string[]>; handled: boolean } | null>(
    null,
  );
  const capture = () => {
    const session = useChatStore.getState().activeSessionId;
    return () =>
      mounted.current &&
      !current.current.readOnly &&
      useChatStore.getState().activeSessionId === session;
  };
  const attachPaths = async (paths: string[], valid: () => boolean) => {
    if (!valid() || !paths.length) return;
    if (!current.current.canPickFiles) {
      toast.info(t("common:fileActions.remoteFileInputRejected"));
      return;
    }
    for (const path of paths) {
      if (!valid()) return;
      await current.current.attachFileByPath(path);
    }
  };
  const failed = () => reportError(t("composer.clipboardFailed"));

  return {
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
      if (current.current.readOnly || event.repeat || event.altKey) return;
      const paste =
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") ||
        (event.shiftKey && event.key === "Insert");
      if (!paste) return;
      const valid = capture();
      const pending = {
        files: readClipboardFiles(),
        handled: false,
      };
      gesture.current = pending;
      // 某些系统文件剪贴板不会产生 DOM paste，此时由快捷键入口接收路径。
      void pending.files
        .then(async (paths) => {
          if (!pending.handled) await attachPaths(paths, valid);
        })
        .catch(() => {
          if (!pending.handled && valid()) failed();
        })
        .finally(() => {
          if (gesture.current === pending) gesture.current = null;
        });
    },
    onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
      if (current.current.readOnly) return;
      const images = clipboardImageFiles(event.clipboardData);
      const text = event.clipboardData.getData("text/plain");
      const pending = gesture.current;
      if (pending) pending.handled = true;
      gesture.current = null;
      const fileData =
        event.clipboardData.files.length > 0 ||
        Array.from(event.clipboardData.types).some(
          (type) => type === "Files" || type === "text/uri-list",
        ) ||
        Array.from(event.clipboardData.items).some(
          (item) => item.kind === "file",
        );
      // 普通文本保留浏览器原生插入与撤销，不等待 IPC，也不猜测文字中的路径。
      if (text && !fileData && !images.length) return;
      event.preventDefault();
      const input = event.currentTarget;
      const value = input.value;
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const valid = capture();
      const insertText = () => {
        if (!text || !valid()) return;
        // 等待读取时用户可能继续输入；只在内容未变化时沿用原选区。
        const from = input.value === value ? start : input.selectionStart;
        const to = input.value === value ? end : input.selectionEnd;
        input.setRangeText(text, from, to, "end");
        current.current.setValue(input.value);
      };
      void (pending?.files ?? readClipboardFiles())
        .then(async (paths) => {
          if (!valid()) return;
          if (paths.length) await attachPaths(paths, valid);
          else if (images.length) await current.current.addFiles(images);
          else if (text) insertText();
          else if (fileData)
            reportError(t("composer.clipboardFilesUnavailable"));
        })
        .catch(() => {
          if (!valid()) return;
          if (text && !images.length) insertText();
          else failed();
        });
    },
  };
}

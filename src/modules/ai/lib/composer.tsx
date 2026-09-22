/**
 * 本文件实现 AI 输入区的共享状态和提交流程。
 * 草稿、附件、语音与命令状态在侧边栏关闭时仍需保留，因此由根级 Provider 持有。
 */

import { parseExternalAgentBinding } from "@/modules/ai/external-agents/runtime";
import { sessionMetadata } from "@/modules/ai/store/chatStore";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { currentWorkspaceBootstrap } from "@/modules/workspace-process";
import {
  pickNativeAttachments,
  readPathAttachment,
  readAsDataURL,
} from "@/modules/ai/lib/attachmentFiles";
import type { AttachmentDisplay } from "@/modules/ai/lib/messageAttachments";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useWhisperRecording } from "@/modules/ai/hooks/useWhisperRecording";
import { expandSnippetTokens, type Snippet } from "@/modules/ai/lib/snippets";
import {
  getAgentMetaForSession,
  stopSession,
  useChatStore,
} from "@/modules/ai/store/chatStore";
import { useSnippetsStore } from "@/modules/ai/store/snippetsStore";
import {
  canRevealSessionCwd,
  resolveSessionCwd,
} from "@/modules/ai/lib/sessions";
import { parseCommand } from "@/modules/ai/commands/registry";
import type { OpenFileGroup } from "@/modules/ai/lib/openFileCandidates";

type AttachmentBase = {
  id: string;
  name: string;
  size: number;
};

export type FileAttachment = AttachmentBase &
  (
    | {
        kind: "image";
        mediaType: string;
        url: string;
        sourcePath?: string;
        environmentKey?: string;
      }
    | {
        kind: "file";
        sourcePath: string;
        environmentKey: string;
      }
    | {
        kind: "selection";
        mediaType: "text/plain";
        text: string;
        /** 选区所属的工作区表面。 */
        source: "terminal" | "editor";
      }
  );

type MessagePart =
  | { type: "text"; text: string }
  | { type: "file"; mediaType: string; url: string; filename?: string };

type Voice = ReturnType<typeof useWhisperRecording>;
type ComposerFiles = FileList | readonly File[];

type ComposerCtx = {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  files: FileAttachment[];
  canPickFiles: boolean;
  pickFiles: () => Promise<void>;
  addFiles: (list: ComposerFiles | null) => Promise<void>;
  /** 按绝对路径附加文件，供文件管理器的“附加到 Agent”操作使用。 */
  attachFileByPath: (path: string) => Promise<void>;
  removeFile: (id: string) => void;
  pickedSnippets: Snippet[];
  addSnippet: (s: Snippet) => void;
  removeSnippet: (id: string) => void;
  isCommand: boolean;
  isBusy: boolean;
  pendingSteering: number;
  canSteer: boolean;
  readOnly: boolean;
  readOnlyEnvironmentKey: string | null;
  workingDirectory: string | null;
  openFileGroups: readonly OpenFileGroup[];
  canRevealWorkingDirectory: boolean;
  revealingWorkingDirectory: boolean;
  revealWorkingDirectory: () => void;
  submit: () => void;
  stop: () => void;
  voice: Voice;
  canSend: boolean;
};

const Ctx = createContext<ComposerCtx | null>(null);

export function useComposer(): ComposerCtx {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error("useComposer must be used inside <AiComposerProvider>");
  return ctx;
}

type ProviderProps = {
  children: React.ReactNode;
  openFileGroups: readonly OpenFileGroup[];
};

/**
 * 为 AI 输入框提供跨面板持久化的草稿、附件和命令状态。
 *
 * Provider 始终挂载，因此关闭侧边栏不会丢失尚未发送的输入。
 */
export function AiComposerProvider({
  children,
  openFileGroups,
}: ProviderProps) {
  const { t } = useTranslation("ai");
  const sessionId = useChatStore((s) => s.activeSessionId);
  const status = useChatStore(
    (state) => getAgentMetaForSession(state, state.activeSessionId).status,
  );
  const runLocked = useChatStore((s) =>
    s.activeSessionId ? Boolean(s.runLockSessionIds[s.activeSessionId]) : false,
  );
  const sessionEnvironmentKey = useChatStore(
    (s) =>
      s.sessions.find((session) => session.id === s.activeSessionId)
        ?.environmentKey,
  );
  const channelId = useChatStore(
    (state) =>
      state.sessions.find((session) => session.id === state.activeSessionId)
        ?.channelId,
  );
  const environmentMismatch =
    sessionEnvironmentKey !== undefined &&
    sessionEnvironmentKey !== currentWorkspaceBootstrap().environmentKey;
  const readOnly = Boolean(channelId) || environmentMismatch;
  const readOnlyEnvironmentKey =
    !channelId && environmentMismatch ? sessionEnvironmentKey : null;
  const workingDirectory = useChatStore((s) => {
    const id = s.activeSessionId;
    if (!id) return null;
    return resolveSessionCwd(id, s.draftSessionId, s.sessions, s.live.draftCwd);
  });
  const canRevealWorkingDirectory = useChatStore((s) => {
    return canRevealSessionCwd(
      s.activeSessionId,
      s.draftSessionId,
      s.sessions,
      currentWorkspaceBootstrap().environmentKey,
    );
  });
  const isBusy = runLocked || status === "thinking" || status === "streaming";
  const draftExternalAgentId = useChatStore((s) => s.draftExternalAgentId);
  const usesExternalAgent = Boolean(
    parseExternalAgentBinding(
      sessionId ? sessionMetadata.get(sessionId) : undefined,
    ) || draftExternalAgentId,
  );
  const canSteer = !usesExternalAgent;
  const pendingSteering = useChatStore(
    (state) => getAgentMetaForSession(state, sessionId).pendingSteering,
  );

  const [value, setValue] = useState("");
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [pickedSnippets, setPickedSnippets] = useState<Snippet[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submittingRef = useRef(false);
  const revealingWorkingDirectoryRef = useRef(false);
  const [revealingWorkingDirectory, setRevealingWorkingDirectory] =
    useState(false);

  /** 导航到当前历史会话的固定工作目录，并合并连续点击。 */
  const revealWorkingDirectory = useCallback(() => {
    if (
      !canRevealWorkingDirectory ||
      !workingDirectory ||
      revealingWorkingDirectoryRef.current
    ) {
      return;
    }
    revealingWorkingDirectoryRef.current = true;
    setRevealingWorkingDirectory(true);
    void useChatStore
      .getState()
      .live.revealWorkingDirectory(workingDirectory)
      .catch(() => toast.error(t("composer.workingDirectoryUnavailable")))
      .finally(() => {
        revealingWorkingDirectoryRef.current = false;
        setRevealingWorkingDirectory(false);
      });
  }, [canRevealWorkingDirectory, t, workingDirectory]);

  const attachFileByPath = useCallback(
    async (path: string) => {
      if (readOnly) return;
      try {
        const workspace = currentWorkspaceEnv();
        const name = basename(path);
        const id = `path-${path}`;
        const result = await readPathAttachment(path, workspace);
        if (result.kind !== "image" && result.kind !== "file") {
          toast.error(t("composer.unsupportedFile", { name }));
          return;
        }
        const environmentKey = currentWorkspaceBootstrap().environmentKey;
        const attachment: FileAttachment =
          result.kind === "image"
            ? {
                id,
                name,
                kind: "image",
                size: result.size,
                sourcePath: path,
                environmentKey,
                mediaType: result.mediaType,
                url: result.url,
              }
            : {
                id,
                name,
                kind: "file",
                size: result.size,
                sourcePath: path,
                environmentKey,
              };
        setFiles((prev) =>
          prev.some((file) => file.id === id) ? prev : [...prev, attachment],
        );
        useChatStore.getState().focusInput();
      } catch (e) {
        toast.error(t("composer.attachFailed", { error: String(e) }));
      }
    },
    [readOnly, t],
  );

  const canPickFiles = currentWorkspaceEnv().kind === "local";
  const pickingFilesRef = useRef(false);
  /** 原生选择器只读取本机文件；远端文件由对应环境的文件树附加。 */
  const pickFiles = async () => {
    if (
      !canPickFiles ||
      readOnly ||
      (isBusy && !canSteer) ||
      pickingFilesRef.current
    )
      return;
    pickingFilesRef.current = true;
    try {
      await pickNativeAttachments(
        currentWorkspaceEnv(),
        t("statusBar.attachFileOrImage"),
        attachFileByPath,
      );
    } catch (error) {
      toast.error(t("composer.attachFailed", { error: String(error) }));
    } finally {
      pickingFilesRef.current = false;
    }
  };

  const focusSignal = useChatStore((s) => s.focusSignal);
  const pendingPrefill = useChatStore((s) => s.pendingPrefill);
  const consumePrefill = useChatStore((s) => s.consumePrefill);
  const pendingSelections = useChatStore((s) => s.pendingSelections);
  const consumeSelections = useChatStore((s) => s.consumeSelections);
  const pendingFileAttachments = useChatStore((s) => s.pendingFileAttachments);
  const consumeFileAttachments = useChatStore((s) => s.consumeFileAttachments);

  useEffect(() => {
    if (focusSignal === 0 || readOnly) return;
    textareaRef.current?.focus();
    if (pendingPrefill != null) {
      const text = consumePrefill();
      if (text) setValue((v) => (v ? `${text}${v}` : text));
    }
  }, [focusSignal, pendingPrefill, consumePrefill, readOnly]);

  // Re-focus the textarea whenever the agent finishes a response
  const prevIsBusyRef = useRef(false);
  useEffect(() => {
    if (prevIsBusyRef.current && !isBusy && !readOnly) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
    prevIsBusyRef.current = isBusy;
  }, [isBusy, readOnly]);

  useEffect(() => {
    if (pendingFileAttachments.length === 0) return;
    const drained = consumeFileAttachments();
    for (const attachment of drained) {
      void attachFileByPath(attachment.path);
    }
  }, [attachFileByPath, consumeFileAttachments, pendingFileAttachments]);

  useEffect(() => {
    if (pendingSelections.length === 0) return;
    const drained = consumeSelections();
    if (drained.length === 0 || readOnly) return;
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.id));
      const next: FileAttachment[] = [];
      for (const sel of drained) {
        if (existing.has(sel.id)) continue;
        next.push({
          id: sel.id,
          name:
            sel.source === "editor" ? "Editor selection" : "Terminal selection",
          kind: "selection",
          mediaType: "text/plain",
          text: sel.text,
          size: sel.text.length,
          source: sel.source,
        });
      }
      return next.length ? [...prev, ...next] : prev;
    });
  }, [pendingSelections, consumeSelections, readOnly]);

  const voice = useWhisperRecording({
    onResult: (transcript: string) => {
      if (readOnly) return;
      setValue((v) => (v ? `${v} ${transcript}` : transcript));
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
  });

  /** 将剪贴板中的内存文件转换为 Composer 附件，不推断磁盘路径。 */
  const addFiles = async (list: ComposerFiles | null) => {
    if (!list || readOnly) return;
    const next: FileAttachment[] = [];
    for (const f of Array.from(list)) {
      const att = await readAttachment(f);
      if (att) next.push(att);
    }
    if (next.length) setFiles((prev) => [...prev, ...next]);
  };

  const removeFile = (id: string) =>
    setFiles((prev) => prev.filter((f) => f.id !== id));

  const addSnippet = (s: Snippet) =>
    setPickedSnippets((prev) =>
      prev.some((p) => p.id === s.id) ? prev : [...prev, s],
    );
  const removeSnippet = (id: string) =>
    setPickedSnippets((prev) => prev.filter((s) => s.id !== id));

  /** 空闲时发送新轮次，内置 Agent 运行中则提交引导；成功接收后才清理草稿。 */
  const submit = () => {
    if (
      submittingRef.current ||
      (isBusy && !canSteer) ||
      readOnly ||
      !workingDirectory
    )
      return;
    const trimmed = value.trim();
    if (!trimmed && files.length === 0 && pickedSnippets.length === 0) return;

    const isCommand = !usesExternalAgent && Boolean(parseCommand(trimmed));

    const parts: MessagePart[] = [];
    const attachments: AttachmentDisplay[] = [];
    const selectionBlocks = files
      .filter((f) => f.kind === "selection")
      .map(
        (f) =>
          `<selection source="${f.source ?? "terminal"}">\n${f.text ?? ""}\n</selection>`,
      );
    const { body: bodyAfterTokens, blocks: snippetBlocks } =
      expandSnippetTokens(trimmed, useSnippetsStore.getState().snippets);
    const seenHandles = new Set<string>();
    const allSnippetBlocks: string[] = [];
    for (const s of pickedSnippets) {
      if (seenHandles.has(s.handle)) continue;
      seenHandles.add(s.handle);
      allSnippetBlocks.push(
        `<snippet name="${s.handle}">\n${s.content}\n</snippet>`,
      );
    }
    for (const block of snippetBlocks) {
      const m = block.match(/^<snippet name="([^"]+)"/);
      if (m && seenHandles.has(m[1])) continue;
      if (m) seenHandles.add(m[1]);
      allSnippetBlocks.push(block);
    }
    const composed = [
      allSnippetBlocks.join("\n\n"),
      selectionBlocks.join("\n\n"),
      bodyAfterTokens,
    ]
      .filter(Boolean)
      .join("\n\n");
    for (const file of files) {
      if (file.kind !== "file") continue;
      attachments.push({
        kind: "file",
        name: file.name,
        size: file.size,
        path: file.sourcePath,
        environmentKey: file.environmentKey,
      });
    }
    if (composed) parts.push({ type: "text", text: composed });

    let mediaIndex = 0;
    for (const f of files) {
      if (f.kind === "image" && f.url) {
        attachments.push({
          kind: "image",
          name: f.name,
          size: f.size,
          sourcePath: f.sourcePath,
          environmentKey: f.environmentKey,
          mediaIndex: mediaIndex++,
        });
        parts.push({
          type: "file",
          mediaType: f.mediaType,
          url: f.url,
          filename: f.name,
        });
      }
    }

    if (!sessionId) return;
    const submittedValue = value;
    const submittedFileIds = new Set(files.map((file) => file.id));
    const submittedSnippetIds = new Set(
      pickedSnippets.map((snippet) => snippet.id),
    );
    const store = useChatStore.getState();
    store.patchAgentMeta(sessionId, {
      hitStepCap: false,
      compacting: false,
    });
    // 接入确认前禁止重复提交同一份草稿，运行中双击不能变成两条引导。
    submittingRef.current = true;
    void (async () => {
      try {
        const { sendChatMessage } = await import(
          "@/modules/ai/store/chatRuntime"
        );
        const sent = await sendChatMessage(
          sessionId,
          {
            role: "user",
            parts: isCommand ? [{ type: "text", text: trimmed }] : parts,
            metadata: {
              createdAt: Date.now(),
              attachments,
            },
          },
          files.length > 0 || pickedSnippets.length > 0,
        );
        if (!sent) {
          toast.info(t("composer.sessionBusy"));
          return;
        }
        setValue((current) => (current === submittedValue ? "" : current));
        setFiles((current) =>
          current.filter((file) => !submittedFileIds.has(file.id)),
        );
        setPickedSnippets((current) =>
          current.filter((snippet) => !submittedSnippetIds.has(snippet.id)),
        );
        requestAnimationFrame(() => textareaRef.current?.focus());
      } catch {
        toast.error(t("composer.sendFailed"));
      } finally {
        submittingRef.current = false;
      }
    })();
  };

  const stop = () => {
    if (!sessionId) return;
    void stopSession(sessionId);
  };

  const canSend =
    (!isBusy || canSteer) &&
    !readOnly &&
    (value.trim().length > 0 || files.length > 0 || pickedSnippets.length > 0);
  const canSubmit = canSend && Boolean(workingDirectory?.trim());

  const ctx: ComposerCtx = {
    textareaRef,
    value,
    setValue,
    files,
    addFiles,
    canPickFiles,
    pickFiles,
    attachFileByPath,
    removeFile,
    pickedSnippets,
    addSnippet,
    removeSnippet,
    isCommand: !usesExternalAgent && Boolean(parseCommand(value)),
    isBusy,
    canSteer,
    pendingSteering,
    readOnly,
    readOnlyEnvironmentKey,
    workingDirectory,
    openFileGroups,
    canRevealWorkingDirectory,
    revealingWorkingDirectory,
    revealWorkingDirectory,
    submit,
    stop,
    voice,
    canSend: canSubmit,
  };

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

async function readAttachment(file: File): Promise<FileAttachment | null> {
  const id = `${file.name}-${file.size}-${file.lastModified}`;
  if (file.type.startsWith("image/")) {
    const url = await readAsDataURL(file);
    return {
      id,
      name: file.name,
      kind: "image",
      mediaType: file.type || "image/png",
      url,
      size: file.size,
    };
  }
  return null;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/** 会话正文的业务渲染入口，连接文件引用菜单与宿主导航。 */
import { ChatStreamingProvider } from "@/components/ai-elements/chat-code";
import { MarkdownCode } from "@/components/ai-elements/markdown-code";
import { streamdownPlugins } from "@/components/ai-elements/streamdown-plugins";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
} from "@/components/menu/context-menu";
import { cn } from "@/lib/utils";
import { normalizeMathDelimiters } from "@/modules/ai/lib/normalizeMathDelimiters";
import { useChatStore } from "@/modules/ai/store/chatStore";
import {
  resolveFileReference,
  type FileTarget,
  openSystemFile,
} from "@/modules/file-actions/actions";
import { FileActionItems } from "@/modules/file-actions/FileActionItems";
import {
  decodeFileReference,
  rehypeFileReferences,
  type FileReference,
} from "@/modules/file-actions/references";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { openUrl } from "@tauri-apps/plugin-opener";
import { memo, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Streamdown,
  defaultRehypePlugins,
  type StreamdownProps,
} from "streamdown";

const [sanitize, schema] = defaultRehypePlugins.sanitize as [
  unknown,
  { protocols?: Record<string, string[]> },
];
const chatRehypePlugins = [
  defaultRehypePlugins.raw,
  rehypeFileReferences,
  [
    sanitize,
    {
      ...schema,
      protocols: {
        ...schema.protocols,
        href: [...(schema.protocols?.href ?? []), "terax-file"],
      },
    },
  ],
  defaultRehypePlugins.harden,
] as NonNullable<StreamdownProps["rehypePlugins"]>;

/** 按目标隔离菜单状态，流式正文改写链接时不复用旧路径的异步结果。 */
function ChatLink({ href, children }: React.ComponentProps<"a">) {
  const reference = decodeFileReference(href ?? "");
  const { t } = useTranslation("common");
  if (reference && href)
    return (
      <ChatFileLink key={href} href={href} reference={reference}>
        {children}
      </ChatFileLink>
    );
  return href && /^(https?:|mailto:)/i.test(href) ? (
    <a
      href={href}
      data-streamdown="link"
      onAuxClick={(event) => event.preventDefault()}
      onClick={(event) => {
        event.preventDefault();
        void openUrl(href).catch((error) =>
          toast.error(t("fileActions.failed"), { description: String(error) }),
        );
      }}
    >
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

function ChatFileLink({
  href,
  reference,
  children,
}: {
  href: string;
  reference: FileReference;
  children: ReactNode;
}) {
  const [resolved, setResolved] = useState<FileTarget | null>(null);
  const { t } = useTranslation("common");
  const open = async (path: string, line?: number) => {
    await useChatStore.getState().live.openFileReference?.(path, line);
  };
  const resolve = () => resolveFileReference(reference);
  return (
    <ContextMenu
      onOpenChange={(isOpen) => {
        if (isOpen)
          void resolve()
            .then(setResolved)
            .catch(() => setResolved(null));
      }}
    >
      <ContextMenuTrigger asChild>
        <a
          href={href}
          title={reference.literalPath}
          data-streamdown="link"
          onAuxClick={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault();
            void resolve()
              .then((file) =>
                file.isDir
                  ? currentWorkspaceEnv().kind === "local"
                    ? openSystemFile(file.path)
                    : useChatStore
                        .getState()
                        .live.revealWorkingDirectory(file.path)
                  : open(file.path, file.line),
              )
              .catch((error) =>
                toast.error(t("fileActions.failed"), {
                  description: String(error),
                }),
              );
          }}
        >
          {children}
        </a>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <FileActionItems
          target={
            resolved ?? {
              path: reference.path,
              line: reference.line,
              isDir: false,
            }
          }
          resolve={resolve}
          onOpen={open}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

const components = { code: MarkdownCode, a: ChatLink };
export const ChatMessageResponse = memo(function ChatMessageResponse({
  children,
  className,
  streaming = false,
}: {
  children: string;
  className?: string;
  streaming?: boolean;
}) {
  const text = useMemo(() => normalizeMathDelimiters(children), [children]);
  return (
    <ChatStreamingProvider value={streaming}>
      <Streamdown
        className={cn(
          "markdown-content size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          className,
        )}
        animated={streaming}
        isAnimating={streaming}
        mode={streaming ? "streaming" : "static"}
        parseIncompleteMarkdown={false}
        components={components}
        rehypePlugins={chatRehypePlugins}
        plugins={streamdownPlugins}
      >
        {text}
      </Streamdown>
    </ChatStreamingProvider>
  );
});

/** 会话正文的业务渲染入口，连接文件引用菜单与宿主导航。 */
import { ChatStreamingProvider } from "@/modules/markdown/chat-code";
import { MarkdownCode } from "@/modules/markdown/markdown-code";
import {
  streamdownPlugins,
  streamdownRemarkPlugins,
} from "@/modules/markdown/streamdown-plugins";
import { cn } from "@/lib/utils";
import { IS_WINDOWS } from "@/lib/platform";
import { normalizeMathDelimiters } from "@/modules/ai/lib/normalizeMathDelimiters";
import { MarkdownTable } from "@/modules/markdown/MarkdownTable";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { FileReferenceLink } from "@/modules/file-actions/FileReferenceLink";
import {
  decodeFileReference,
  rehypeFileReferences,
  withFileReferenceProtocol,
} from "@/modules/file-actions/references";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  createContext,
  memo,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { reportError } from "@/lib/errors";
import {
  Streamdown,
  defaultRehypePlugins,
  type StreamdownProps,
} from "streamdown";

const [sanitize, schema] = defaultRehypePlugins.sanitize as [
  unknown,
  { protocols?: Record<string, string[]> },
];
const ChatFileReferenceBaseContext = createContext<string | null>(null);

/** 会话一旦发送首条消息，所有正文和 Subagent 结果共用冻结的 cwd。 */
export function ChatFileReferenceBaseProvider({
  baseDirectory,
  children,
}: {
  baseDirectory: string | null;
  children: ReactNode;
}) {
  return (
    <ChatFileReferenceBaseContext.Provider value={baseDirectory}>
      {children}
    </ChatFileReferenceBaseContext.Provider>
  );
}

function buildChatRehypePlugins(baseDirectory: string | null) {
  const windowsLocal = IS_WINDOWS && currentWorkspaceEnv().kind === "local";
  return [
    defaultRehypePlugins.raw,
    [
      rehypeFileReferences,
      { baseDirectory: baseDirectory ?? undefined, windowsLocal },
    ],
    [
      sanitize,
      {
        ...schema,
        protocols: {
          ...schema.protocols,
          href: withFileReferenceProtocol(schema.protocols?.href),
        },
      },
    ],
    defaultRehypePlugins.harden,
  ] as NonNullable<StreamdownProps["rehypePlugins"]>;
}

/** 按目标隔离菜单状态，流式正文改写链接时不复用旧路径的异步结果。 */
function ChatLink({ href, children }: React.ComponentProps<"a">) {
  const reference = decodeFileReference(href ?? "");
  const { t } = useTranslation("common");
  if (reference && href)
    return (
      <FileReferenceLink
        key={href}
        href={href}
        reference={reference}
        onOpen={(path, line) =>
          useChatStore.getState().live.openFileReference?.(path, line)
        }
        onOpenDirectory={(path) =>
          useChatStore.getState().live.revealWorkingDirectory(path)
        }
      >
        {children}
      </FileReferenceLink>
    );
  return href && /^(https?:|mailto:)/i.test(href) ? (
    <a
      href={href}
      data-streamdown="link"
      onAuxClick={(event) => event.preventDefault()}
      onClick={(event) => {
        event.preventDefault();
        void openUrl(href).catch((error) =>
          reportError(t("fileActions.failed"), { error }),
        );
      }}
    >
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

const components = { code: MarkdownCode, a: ChatLink, table: MarkdownTable };
export const ChatMessageResponse = memo(function ChatMessageResponse({
  children,
  className,
  streaming = false,
}: {
  children: string;
  className?: string;
  streaming?: boolean;
}) {
  const baseDirectory = useContext(ChatFileReferenceBaseContext);
  const text = useMemo(() => normalizeMathDelimiters(children), [children]);
  const rehypePlugins = useMemo(
    () => buildChatRehypePlugins(baseDirectory),
    [baseDirectory],
  );
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
        tableMaxHeight={420}
        components={components}
        rehypePlugins={rehypePlugins}
        remarkPlugins={streamdownRemarkPlugins}
        plugins={streamdownPlugins}
      >
        {text}
      </Streamdown>
    </ChatStreamingProvider>
  );
});

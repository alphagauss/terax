/** 用户气泡外的附件入口，仅在点击后挂载发送快照预览。 */
import { lazy, Suspense, useState } from "react";
import type { UIMessage } from "ai";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/controls/button";
import { Hint } from "@/components/controls/tooltip";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/menu/context-menu";
import { FileActionItems } from "@/modules/file-actions/FileActionItems";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { currentWorkspaceBootstrap } from "@/modules/workspace-process";
import { messageMetadata } from "@/modules/ai/lib/conversation";
import {
  messageRawText,
  textAttachments,
  type AttachmentDisplay,
} from "@/modules/ai/lib/messageAttachments";
import { File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

const AttachmentPreview = lazy(
  () => import("@/modules/ai/components/AttachmentPreview"),
);

export type AttachmentItem = { display: AttachmentDisplay; url?: string };

export function MessageAttachments({ message }: { message: UIMessage }) {
  const { t } = useTranslation("ai");
  const [selected, setSelected] = useState<AttachmentItem | null>(null);
  const displays = messageMetadata(message).attachments ?? [];
  const files = message.parts.filter((part) => part.type === "file");
  const items: AttachmentItem[] = textAttachments(
    messageRawText(message),
    displays,
  ).map((display) => ({ display }));
  files.forEach((file, mediaIndex) => {
    if (!file.mediaType.startsWith("image/")) return;
    const display = displays.find(
      (a) => a.kind === "image" && a.mediaIndex === mediaIndex,
    ) ?? {
      kind: "image" as const,
      mediaIndex,
      name: file.filename ?? t("attachments.image"),
      size: 0,
    };
    items.push({ display, url: file.url });
  });
  if (!items.length) return null;
  return (
    <>
      <div className="flex max-w-full flex-wrap justify-end gap-1.5">
        {items.map((item) => {
          const { display, url } = item;
          const canOpenSource =
            display.sourcePath &&
            display.environmentKey ===
              currentWorkspaceBootstrap().environmentKey;
          return (
            <ContextMenu
              key={
                display.kind === "text"
                  ? `text-${display.blockRange[0]}`
                  : `image-${display.mediaIndex}`
              }
            >
              <ContextMenuTrigger asChild>
                <Hint content={display.sourcePath ?? display.name}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelected(item)}
                    aria-label={t("attachments.preview", {
                      name: display.name,
                    })}
                    className={
                      url
                        ? "size-20 overflow-hidden p-0"
                        : "h-auto max-w-full gap-1.5 py-1.5"
                    }
                  >
                    {url ? (
                      <img
                        src={url}
                        alt={display.name}
                        loading="lazy"
                        className="size-full object-contain"
                      />
                    ) : (
                      <>
                        <HugeiconsIcon icon={File01Icon} size={14} />
                        <span className="truncate">{display.name}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {Math.ceil(display.size / 1024)} KB
                        </span>
                      </>
                    )}
                  </Button>
                </Hint>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => setSelected(item)}>
                  {t("attachments.viewSnapshot")}
                </ContextMenuItem>
                {canOpenSource && display.sourcePath ? (
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      {t("attachments.sourceFile")}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <FileActionItems
                        target={{ path: display.sourcePath, isDir: false }}
                        onOpen={(path, line) =>
                          useChatStore
                            .getState()
                            .live.openFileReference?.(path, line)
                        }
                      />
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                ) : null}
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
      {selected ? (
        <Suspense fallback={null}>
          <AttachmentPreview
            item={selected}
            message={message}
            onClose={() => setSelected(null)}
          />
        </Suspense>
      ) : null}
    </>
  );
}

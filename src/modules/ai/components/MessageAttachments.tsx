/** 用户消息的附件入口；路径文件复用工作区文件操作，图片保留发送媒体预览。 */
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
import type { MessageAttachment } from "@/modules/ai/lib/messageAttachments";
import File01Icon from "@hugeicons/core-free-icons/File01Icon";
import { HugeiconsIcon } from "@hugeicons/react";

const AttachmentPreview = lazy(
  () => import("@/modules/ai/components/AttachmentPreview"),
);

export type ImageAttachmentItem = {
  kind: "image";
  display: Extract<MessageAttachment, { kind: "image" }>;
  url: string;
};

export function MessageAttachments({ message }: { message: UIMessage }) {
  const { t } = useTranslation("ai");
  const [selected, setSelected] = useState<ImageAttachmentItem | null>(null);
  const displays = messageMetadata(message).attachments ?? [];
  const items: Array<
    | {
        kind: "file";
        display: Extract<MessageAttachment, { kind: "file" }>;
      }
    | ImageAttachmentItem
  > = displays.flatMap((display) =>
    display.kind === "file" ? [{ kind: "file" as const, display }] : [],
  );
  const media = message.parts.filter((part) => part.type === "file");
  media.forEach((file, mediaIndex) => {
    if (!file.mediaType.startsWith("image/")) return;
    const display = displays.find(
      (
        attachment,
      ): attachment is Extract<MessageAttachment, { kind: "image" }> =>
        attachment.kind === "image" && attachment.mediaIndex === mediaIndex,
    ) ?? {
      kind: "image" as const,
      mediaIndex,
      name: file.filename ?? t("attachments.image"),
      size: 0,
    };
    items.push({ kind: "image", display, url: file.url });
  });
  if (!items.length) return null;

  const open = (path: string, line?: number) =>
    useChatStore.getState().live.openFileReference?.(path, line);

  return (
    <>
      <div className="flex max-w-full flex-wrap justify-end gap-1.5">
        {items.map((item) => {
          if (item.kind === "file") {
            const { display } = item;
            const available =
              display.environmentKey ===
              currentWorkspaceBootstrap().environmentKey;
            const button = (
              <Hint content={display.path}>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!available}
                  onClick={() => void open(display.path)}
                  aria-label={`${t("common:fileActions.open")}: ${display.name}`}
                  className="h-auto max-w-full gap-1.5 py-1.5"
                >
                  <HugeiconsIcon icon={File01Icon} size={14} />
                  <span className="truncate">{display.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {Math.ceil(display.size / 1024)} KB
                  </span>
                </Button>
              </Hint>
            );
            if (!available)
              return <div key={`file-${display.path}`}>{button}</div>;
            return (
              <ContextMenu key={`file-${display.path}`}>
                <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
                <ContextMenuContent>
                  <FileActionItems
                    target={{ path: display.path, isDir: false }}
                    onOpen={open}
                  />
                </ContextMenuContent>
              </ContextMenu>
            );
          }

          const { display } = item;
          const path = display.sourcePath;
          const available =
            Boolean(path) &&
            display.environmentKey ===
              currentWorkspaceBootstrap().environmentKey;
          return (
            <ContextMenu key={`image-${display.mediaIndex}`}>
              <ContextMenuTrigger asChild>
                <Hint content={path ?? display.name}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelected(item)}
                    aria-label={t("attachments.preview", {
                      name: display.name,
                    })}
                    className="size-20 overflow-hidden p-0"
                  >
                    <img
                      src={item.url}
                      alt={display.name}
                      loading="lazy"
                      className="size-full object-contain"
                    />
                  </Button>
                </Hint>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => setSelected(item)}>
                  {t("attachments.viewSnapshot")}
                </ContextMenuItem>
                {available && path ? (
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      {t("attachments.sourceFile")}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <FileActionItems
                        target={{ path, isDir: false }}
                        onOpen={open}
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
            onClose={() => setSelected(null)}
          />
        </Suspense>
      ) : null}
    </>
  );
}

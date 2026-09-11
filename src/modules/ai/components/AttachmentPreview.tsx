/** 按需读取消息中的发送快照，图片缩放和代码高亮不读取或修改源文件。 */
import { useRef, useState } from "react";
import type { UIMessage } from "ai";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/controls/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/controls/dialog";
import type { AttachmentItem } from "@/modules/ai/components/MessageAttachments";
import { messageRawText } from "@/modules/ai/lib/messageAttachments";
import { ChatCodeBlock } from "@/modules/markdown/chat-code";
import { copyMarkdownImage } from "@/modules/markdown/lib/imageActions";

export default function AttachmentPreview({
  item,
  message,
  onClose,
}: {
  item: AttachmentItem;
  message: UIMessage;
  onClose: () => void;
}) {
  const { t } = useTranslation("ai");
  const [zoom, setZoom] = useState(1);
  const imageRef = useRef<HTMLImageElement>(null);
  const { display, url } = item;
  const content =
    display.kind === "text"
      ? messageRawText(message).slice(...display.contentRange)
      : "";
  const dot = display.name.lastIndexOf(".");
  const ext = dot > 0 ? display.name.slice(dot + 1).toLowerCase() : "";
  const [saving, setSaving] = useState(false);
  const saveText = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await invoke("text_save_as", {
        content,
        filename: display.name,
        extension: /^[a-z0-9]+$/i.test(ext) ? ext : null,
        title: t("attachments.saveSnapshot"),
        fileFilter: t("attachments.textFile"),
      });
    } catch {
      toast.error(t("attachments.saveFailed"));
    } finally {
      setSaving(false);
    }
  };
  const lang = ext === "mermaid" ? "text" : ext || "text";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="break-all">{display.name}</DialogTitle>
          <DialogDescription>{t("attachments.snapshot")}</DialogDescription>
        </DialogHeader>
        {url ? (
          <>
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="outline"
                size="sm"
                disabled={zoom <= 0.25}
                onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
              >
                {t("attachments.zoomOut")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setZoom(1)}>
                {Math.round(zoom * 100)}%
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={zoom >= 4}
                onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
              >
                {t("attachments.zoomIn")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (imageRef.current)
                    void copyMarkdownImage(imageRef.current)
                      .then(() => toast.success(t("attachments.copied")))
                      .catch(() => toast.error(t("attachments.failed")));
                }}
              >
                {t("attachments.copyImage")}
              </Button>
            </div>
            <div className="min-h-0 overflow-auto">
              <img
                ref={imageRef}
                src={url}
                alt={display.name}
                className="mx-auto object-contain"
                style={{ width: `${zoom * 100}%`, maxWidth: "none" }}
              />
            </div>
          </>
        ) : (
          <>
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() => void saveText()}
              >
                {t("attachments.saveSnapshot")}
              </Button>
            </div>
            <div className="min-h-0 overflow-auto">
              <ChatCodeBlock code={content} lang={lang} />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 按需预览用户消息中的图片媒体。 */
import { writeClipboardImage } from "@/lib/imageActions";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/controls/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/controls/dialog";
import type { ImageAttachmentItem } from "@/modules/ai/components/MessageAttachments";

export default function AttachmentPreview({
  item,
  onClose,
}: {
  item: ImageAttachmentItem;
  onClose: () => void;
}) {
  const { t } = useTranslation("ai");
  const [zoom, setZoom] = useState(1);
  const imageRef = useRef<HTMLImageElement>(null);
  const { display, url } = item;
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
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="outline"
            size="sm"
            disabled={zoom <= 0.25}
            onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}
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
            onClick={() => setZoom((value) => Math.min(4, value + 0.25))}
          >
            {t("attachments.zoomIn")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (imageRef.current)
                void writeClipboardImage(imageRef.current)
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
      </DialogContent>
    </Dialog>
  );
}

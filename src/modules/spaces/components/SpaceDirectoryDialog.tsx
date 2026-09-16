/** WSL 与 SSH 使用当前环境路径输入，不调用宿主系统目录选择器。 */
import { Button } from "@/components/controls/button";
import { DirectoryPathInput } from "@/modules/workspace/DirectoryPathInput";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/controls/dialog";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function SpaceDirectoryDialog({
  title,
  onClose,
  onSubmit,
}: {
  title: string;
  onClose: () => void;
  onSubmit: (path: string) => Promise<void>;
}) {
  const { t } = useTranslation("spaces");
  const [path, setPath] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("directoryDescription")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending || !path.trim()) return;
            setPending(true);
            void onSubmit(path.trim()).finally(() => setPending(false));
          }}
        >
          <DirectoryPathInput
            autoFocus
            value={path}
            onValueChange={setPath}
            placeholder={t("directoryPlaceholder")}
            aria-label={t("directoryPlaceholder")}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common:cancel")}
            </Button>
            <Button type="submit" disabled={pending || !path.trim()}>
              {t("openDirectory")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

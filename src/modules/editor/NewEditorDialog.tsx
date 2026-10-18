/**
 * 本文件实现新建编辑器文件的对话框。
 * 收集文件名并交由所属编辑器流程处理，使用公共控件统一输入与操作反馈。
 */
import { Button } from "@/components/controls/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/controls/dialog";
import { Input } from "@/components/controls/input";
import { currentWorkspaceEnv } from "@/modules/workspace";
import File02Icon from "@hugeicons/core-free-icons/File02Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { reportError } from "@/lib/errors";
import { useTranslation } from "react-i18next";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rootPath: string | null;
  onCreated: (path: string) => void;
};

function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/")) return `${parent}${name}`;
  return `${parent}/${name}`;
}

/** 收集新文件信息并在确认后通知调用方，不自行创建编辑器页面。 */
export function NewEditorDialog({
  open,
  onOpenChange,
  rootPath,
  onCreated,
}: Props) {
  const { t } = useTranslation("editor");
  const [name, setName] = useState("untitled.txt");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName("untitled.txt");
    setError(null);
    // Pre-select the basename so the user can quickly retype the filename
    // while keeping the extension handy.
    setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const dot = el.value.lastIndexOf(".");
      el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
    }, 0);
  }, [open]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("nameRequired"));
      return;
    }
    if (trimmed.includes("..")) {
      setError(t("pathMustBeRelative"));
      return;
    }
    if (!rootPath) {
      setError(t("noWorkspaceRoot"));
      return;
    }
    const path = trimmed.startsWith("/")
      ? trimmed
      : joinPath(rootPath, trimmed);
    try {
      await invoke("fs_create_file", {
        path,
        workspace: currentWorkspaceEnv(),
      });
      onCreated(path);
      onOpenChange(false);
    } catch (e) {
      reportError(t("common:errors.operationFailed"), { error: e });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex gap-1.75">
            <HugeiconsIcon icon={File02Icon} size={16} strokeWidth={1.75} />
            {t("newFile")}
          </DialogTitle>
          <DialogDescription>{t("newFileDescription")}</DialogDescription>
        </DialogHeader>
        <Input
          ref={inputRef}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={t("newFilePlaceholder")}
        />
        {error ? (
          <div className="text-xs text-destructive">{error}</div>
        ) : (
          <div className="text-xs text-muted-foreground truncate">
            {rootPath ? joinPath(rootPath, name.trim() || "…") : "—"}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button onClick={() => void submit()}>{t("common:create")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

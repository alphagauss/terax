/** 共用文件菜单；远端环境只暴露现有文件访问和下载能力。 */
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/menu/context-menu";
import {
  copyFileContent,
  copyFilePath,
  openSystemFile,
  revealFile,
  type FileTarget,
} from "@/modules/file-actions/actions";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { requestTransferPanel } from "@/modules/transfers/store";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { reportError } from "@/lib/errors";

export function FileActionItems({
  target,
  onOpen,
  onOpenDirectory,
  onOpenTerminal,
  onCopyRelativePath,
  resolve,
}: {
  target: FileTarget;
  onCopyRelativePath?: () => void;
  onOpenTerminal?: (path: string) => void;
  onOpen: (path: string, line?: number) => void | Promise<void>;
  resolve?: () => Promise<FileTarget>;
  onOpenDirectory?: (path: string) => void | Promise<void>;
}) {
  const { t } = useTranslation("common");
  const local = currentWorkspaceEnv().kind === "local";
  const run = (action: (file: FileTarget) => unknown) => {
    void (async () => action(resolve ? await resolve() : target))().catch(
      (error) => {
        const code = error instanceof Error ? error.message : String(error);
        reportError(t("fileActions.failed"), {
          description:
            code === "binary" || code === "toolarge"
              ? t(`fileActions.${code}`)
              : code,
        });
      },
    );
  };
  return (
    <>
      {(!target.isDir || local || onOpenDirectory) && (
        <ContextMenuItem
          onSelect={() =>
            run((file) =>
              file.isDir
                ? onOpenDirectory
                  ? onOpenDirectory(file.path)
                  : local
                    ? openSystemFile(file.path)
                    : undefined
                : onOpen(file.path, file.line),
            )
          }
        >
          {t(
            target.isDir
              ? onOpenDirectory
                ? "spaces:openInNewSpace"
                : "fileActions.openDirectory"
              : "fileActions.open",
          )}
        </ContextMenuItem>
      )}
      {local && !target.isDir && (
        <ContextMenuItem
          onSelect={() =>
            run((file) =>
              invoke("file_open_with", {
                path: file.path,
                title: t("fileActions.openWith"),
              }),
            )
          }
        >
          {t("fileActions.openWith")}
        </ContextMenuItem>
      )}
      {local && (
        <ContextMenuItem onSelect={() => run((file) => revealFile(file.path))}>
          {t("fileActions.reveal")}
        </ContextMenuItem>
      )}
      {target.isDir && onOpenTerminal && (
        <ContextMenuItem onSelect={() => onOpenTerminal(target.path)}>
          {t("explorer:menu.openInTerminal")}
        </ContextMenuItem>
      )}
      {(!target.isDir || local || onOpenDirectory || onOpenTerminal) && (
        <ContextMenuSeparator />
      )}
      <ContextMenuItem
        onSelect={() => {
          void (async () => {
            const file = resolve ? await resolve().catch(() => target) : target;
            await copyFilePath(file.path);
          })().catch((error) =>
            reportError(t("fileActions.failed"), {
              error,
            }),
          );
        }}
      >
        {t("fileActions.copyPath")}
      </ContextMenuItem>
      {onCopyRelativePath && (
        <ContextMenuItem onSelect={onCopyRelativePath}>
          {t("explorer:menu.copyRelativePath")}
        </ContextMenuItem>
      )}
      {!target.isDir && (
        <ContextMenuItem
          onSelect={() => run((file) => copyFileContent(file.path))}
        >
          {t("fileActions.copyContent")}
        </ContextMenuItem>
      )}
      {!target.isDir && <ContextMenuSeparator />}
      {!target.isDir && (
        <ContextMenuItem
          onSelect={() =>
            run(async (file) => {
              const queued = await invoke<string | null>("file_save_as", {
                path: file.path,
                title: t("fileActions.saveAs"),
              });
              if (queued && !local) requestTransferPanel(queued);
            })
          }
        >
          {t("fileActions.saveAs")}
        </ContextMenuItem>
      )}
    </>
  );
}

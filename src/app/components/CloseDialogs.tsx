/**
 * 本文件集中渲染标签页、Space 与应用关闭时的确认对话框。
 *
 * 应用关闭对话框同时承载未保存内容、保存超时和保存失败状态。
 */

import type { AppCloseDialogState } from "@/app/hooks/useAppCloseGuard";
import type { CloseAllTabsConfirmation } from "@/app/hooks/useTabCloseGuards";
import { Button } from "@/components/controls/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/controls/alert-dialog";
import type { Tab } from "@/modules/workbench";
import { useTranslation } from "react-i18next";

type Props = {
  tabs: Tab[];
  pendingCloseTab: number | null;
  onCancelClose: () => void;
  onConfirmClose: () => void;
  pendingTerminalCloseTab: number | null;
  onCancelTerminalClose: () => void;
  onConfirmTerminalClose: () => void;
  pendingDeleteTabs: number[] | null;
  onCancelDeleteClose: () => void;
  onConfirmDeleteClose: () => void;
  pendingCloseAllTabs: CloseAllTabsConfirmation | null;
  onCancelCloseAllTabs: () => void;
  onConfirmCloseAllTabs: () => void;
  onRestoreCloseAllTabsFocus: () => void;
  pendingAppClose: AppCloseDialogState | null;
  onCancelAppClose: () => void;
  onConfirmAppClose: () => void;
  pendingSpaceDelete: {
    dirtyDocuments: number;
    busyTerminal: boolean;
  } | null;
  onCancelSpaceDelete: () => void;
  onConfirmSpaceDelete: () => void;
};

/** 渲染关闭脏编辑器、活动终端、Space 和应用时的确认对话框。 */
export function CloseDialogs({
  tabs,
  pendingCloseTab,
  onCancelClose,
  onConfirmClose,
  pendingTerminalCloseTab,
  onCancelTerminalClose,
  onConfirmTerminalClose,
  pendingDeleteTabs,
  onCancelDeleteClose,
  onConfirmDeleteClose,
  pendingCloseAllTabs,
  onCancelCloseAllTabs,
  onConfirmCloseAllTabs,
  onRestoreCloseAllTabsFocus,
  pendingAppClose,
  onCancelAppClose,
  onConfirmAppClose,
  pendingSpaceDelete,
  onCancelSpaceDelete,
  onConfirmSpaceDelete,
}: Props) {
  const { t } = useTranslation("app");
  return (
    <>
      <AlertDialog
        open={pendingCloseTab !== null}
        onOpenChange={(open) => !open && onCancelClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("close.unsavedChanges")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tabs.find((tb) => tb.id === pendingCloseTab)?.title
                ? t("close.fileUnsavedNamed", {
                    title: tabs.find((tb) => tb.id === pendingCloseTab)?.title,
                  })
                : t("close.fileUnsaved")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelClose}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmClose}>
              {t("close.closeAnyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingTerminalCloseTab !== null}
        onOpenChange={(open) => !open && onCancelTerminalClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("close.closeTerminalTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("close.closeTerminalDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelTerminalClose}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmTerminalClose}>
              {t("close.closeAnyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingDeleteTabs !== null}
        onOpenChange={(open) => !open && onCancelDeleteClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("close.unsavedChanges")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteTabs?.length === 1
                ? (() => {
                    const title = tabs.find(
                      (tb) => tb.id === pendingDeleteTabs[0],
                    )?.title;
                    return title
                      ? t("close.fileDeletedUnsavedNamed", { title })
                      : t("close.fileDeletedUnsaved");
                  })()
                : t("close.filesDeletedUnsaved", {
                    count: pendingDeleteTabs?.length ?? 0,
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelDeleteClose}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmDeleteClose}>
              {t("close.closeAnyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingCloseAllTabs !== null}
        onOpenChange={(open) => !open && onCancelCloseAllTabs()}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onRestoreCloseAllTabsFocus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t("close.closeAllTabsTitle")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-1">
                {pendingCloseAllTabs && (
                  <>
                    <p>
                      {t("close.closeAllTabsScope", {
                        count: pendingCloseAllTabs.tabIds.length,
                        spaces: t("close.closeAllTabsSpaces", {
                          count: pendingCloseAllTabs.spaces,
                        }),
                      })}
                    </p>
                    {pendingCloseAllTabs.dirtyDocuments > 0 && (
                      <p>
                        {t("close.closeAllTabsDirty", {
                          count: pendingCloseAllTabs.dirtyDocuments,
                        })}
                      </p>
                    )}
                    {pendingCloseAllTabs.terminalsToConfirm > 0 && (
                      <p>
                        {t("close.closeAllTabsBusy", {
                          count: pendingCloseAllTabs.terminalsToConfirm,
                        })}
                      </p>
                    )}
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <Button variant="destructive" onClick={onConfirmCloseAllTabs}>
              {t("close.closeAnyway")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingSpaceDelete !== null}
        onOpenChange={(open) => !open && onCancelSpaceDelete()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("close.deleteSpaceTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingSpaceDelete
                ? t(
                    pendingSpaceDelete.busyTerminal
                      ? pendingSpaceDelete.dirtyDocuments > 0
                        ? "close.deleteSpaceBusyDirty"
                        : "close.deleteSpaceBusy"
                      : "close.deleteSpaceDirty",
                    { count: pendingSpaceDelete.dirtyDocuments },
                  )
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelSpaceDelete}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmSpaceDelete}>
              {t("close.deleteSpaceAnyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingAppClose !== null}
        onOpenChange={(open) => !open && onCancelAppClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingAppClose?.kind === "saving"
                ? t("close.quitSavingTitle")
                : pendingAppClose?.kind === "failed"
                  ? t("close.quitFailedTitle")
                  : t("close.quitTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAppClose
                ? pendingAppClose.kind === "blocker"
                  ? t(
                      pendingAppClose.busyTerminal
                        ? pendingAppClose.dirtyEditors > 0
                          ? "close.quitBusyDirty"
                          : "close.quitBusy"
                        : "close.quitDirty",
                      { count: pendingAppClose.dirtyEditors },
                    )
                  : pendingAppClose.kind === "saving"
                    ? t("close.quitSaving")
                    : t("close.quitFailed", {
                        reason: pendingAppClose.reason,
                      })
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <Button
              variant={
                pendingAppClose?.kind === "blocker" ? "default" : "destructive"
              }
              onClick={onConfirmAppClose}
            >
              {pendingAppClose?.kind === "blocker"
                ? t("close.quitAnyway")
                : t("close.forceQuit")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

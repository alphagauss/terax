import type { AppCloseBlocker } from "@/app/hooks/useAppCloseGuard";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  pendingAppClose: AppCloseBlocker | null;
  onCancelAppClose: () => void;
  onConfirmAppClose: () => void;
  pendingSpaceDelete: {
    dirtyDocuments: number;
    busyTerminal: boolean;
  } | null;
  onCancelSpaceDelete: () => void;
  onConfirmSpaceDelete: () => void;
};

/** Confirmation dialogs for closing dirty editors and terminals with live processes. */
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
            <AlertDialogTitle>{t("close.quitTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAppClose
                ? t(
                    pendingAppClose.busyTerminal
                      ? pendingAppClose.dirtyEditors > 0
                        ? "close.quitBusyDirty"
                        : "close.quitBusy"
                      : "close.quitDirty",
                    { count: pendingAppClose.dirtyEditors },
                  )
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelAppClose}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmAppClose}>
              {t("close.quitAnyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

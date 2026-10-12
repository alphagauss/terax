/** 标题栏中的当前窗口错误入口；没有记录时不占用空间。 */
import { useStore } from "zustand";
import { useTranslation } from "react-i18next";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/controls/button";
import { Hint } from "@/components/controls/tooltip";
import { errorStore, setErrorHistoryOpen } from "@/lib/errors";

export function ErrorHistoryButton() {
  const { t } = useTranslation("common");
  const count = useStore(errorStore, (state) => state.reports.length);
  const open = useStore(errorStore, (state) => state.historyOpen);
  if (!count) return null;
  const label = t("errors.history", { count });
  return (
    <Hint content={label} aria-expanded={open}>
      <Button
        data-error-history-button
        aria-label={label}
        aria-expanded={open}
        aria-controls="error-history-list"
        size="icon-sm"
        variant="ghost-destructive"
        className="shrink-0"
        onClick={() => setErrorHistoryOpen(!open)}
      >
        <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.75} />
      </Button>
    </Hint>
  );
}

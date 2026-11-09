import { Button } from "@/components/controls/button";
import { Hint } from "@/components/controls/tooltip";
import FileEditIcon from "@hugeicons/core-free-icons/FileEditIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslation } from "react-i18next";

/** 源码管理的文件行共用工作区文件打开按钮。 */
export function OpenWorkingFileButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("sourceControl");
  const label = t("menu.openFile");
  return (
    <Hint content={label} side="top">
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="size-5 disabled:cursor-not-allowed"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        <HugeiconsIcon icon={FileEditIcon} size={13} />
      </Button>
    </Hint>
  );
}

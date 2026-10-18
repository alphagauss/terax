/** 原位错误与窗口诊断共用运行身份；隐藏页面和卸载组件不代表业务已恢复。 */
import { useEffect, useRef, type ReactNode } from "react";
import { useStore } from "zustand";
import { useTranslation } from "react-i18next";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/controls/button";
import {
  dismissErrorNotice,
  errorStore,
  reportErrorNotice,
  resolveErrorNotice,
  showErrorNoticeDetails,
  type ErrorOptions,
} from "@/lib/errors";

export type ErrorNoticeProps = {
  identity: string;
  title: string;
  options?: Omit<ErrorOptions, "identity" | "overlay">;
  active?: boolean;
  visible?: boolean;
  mode?: "inline" | "overlay" | "both";
  dismissible?: boolean;
  hasDetails?: boolean;
  children?: ReactNode;
};

/** identity 必须标识一次失败；恢复时传 active=false，重新操作须使用新身份。 */
export function ErrorNotice({
  identity,
  title,
  options,
  active = true,
  visible = true,
  mode = "inline",
  dismissible = false,
  hasDetails = false,
  children,
}: ErrorNoticeProps) {
  const { t } = useTranslation("common");
  const dismissed = useStore(
    errorStore,
    (state) => state.notices.get(identity) === "dismissed",
  );
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (!active) resolveErrorNotice(previous.current ?? identity);
    previous.current = active ? identity : null;
    if (active && visible && mode !== "inline")
      reportErrorNotice(identity, title, options ?? {});
  }, [active, visible, mode, identity, title, options]);

  if (!active || dismissed || mode === "overlay") return null;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-1 text-xs text-destructive"
    >
      <span className="min-w-0 break-words">{title}</span>
      {hasDetails && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => showErrorNoticeDetails(identity, title, options ?? {})}
        >
          {t("errors.details")}
        </Button>
      )}
      {dismissible && (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={t("errors.dismissNotice")}
          onClick={() => dismissErrorNotice(identity)}
        >
          <HugeiconsIcon
            icon={Cancel01Icon}
            size={14}
            strokeWidth={2}
            aria-hidden="true"
          />
        </Button>
      )}
      {children}
    </div>
  );
}

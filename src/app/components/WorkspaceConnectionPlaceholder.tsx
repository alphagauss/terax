/**
 * 本文件实现远端 Workspace 启动期间的主区域占位提示。
 * 持久化页面尚未恢复时遮住初始空 Workbench，避免把临时空态误认为真实布局。
 */

import { Spinner } from "@/components/ui/spinner";
import { useTranslation } from "react-i18next";

/** 展示 SSH 连接和持久化页面恢复仍在进行的阻塞提示。 */
export function WorkspaceConnectionPlaceholder() {
  const { t } = useTranslation("common");
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-8 text-center">
      <div className="flex max-w-sm flex-col items-center gap-2 text-muted-foreground">
        <Spinner
          className="size-5 motion-reduce:animate-none"
          aria-hidden="true"
        />
        <p className="text-sm font-medium text-foreground">
          {t("remoteWorkspace.connecting")}
        </p>
        <p className="text-xs leading-relaxed">
          {t("remoteWorkspace.restoreAfterConnection")}
        </p>
      </div>
    </div>
  );
}

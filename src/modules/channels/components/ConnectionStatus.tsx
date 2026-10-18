/**
 * 本文件展示连接状态与消息处理状态。
 * 数据只消费服务快照，不创建轮询或复制 Agent 运行状态。
 */

import { cn } from "@/lib/utils";
import type { ChannelSnapshot } from "@/modules/channels/types";
import { useTranslation } from "react-i18next";
import AlertCircleIcon from "@hugeicons/core-free-icons/AlertCircleIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { Hint } from "@/components/controls/tooltip";

/** 在设置和通知入口使用相同描述，未绑定账号的实例明确提示需要登录。 */
export function ConnectionStatus({
  snapshot,
  className,
}: {
  snapshot: ChannelSnapshot;
  className?: string;
}) {
  const { t } = useTranslation("channels");
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          snapshot.status === "error"
            ? "bg-destructive"
            : snapshot.status === "online"
              ? "bg-emerald-500"
              : "bg-muted-foreground/50",
        )}
      />
      <span className="min-w-0 truncate">
        {t(
          `status.${snapshot.connection.accountId ? snapshot.status : "login-required"}`,
        )}
        {snapshot.busy ? ` · ${t("busy")}` : ""}
        {snapshot.queued ? ` · ${t("queued", { count: snapshot.queued })}` : ""}
      </span>
      {snapshot.issue && (
        <Hint content={t(`errors.${snapshot.issue}`)}>
          <span
            role="img"
            aria-label={t(`errors.${snapshot.issue}`)}
            className={cn(
              "shrink-0",
              snapshot.issue === "delivery-unknown"
                ? "text-amber-600 dark:text-amber-400"
                : "text-destructive",
            )}
          >
            <HugeiconsIcon icon={AlertCircleIcon} className="size-3" />
          </span>
        </Hint>
      )}
    </span>
  );
}

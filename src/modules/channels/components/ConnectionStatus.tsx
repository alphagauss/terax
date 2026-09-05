/**
 * 本文件展示连接状态与消息处理状态。
 * 数据只消费服务快照，不创建轮询或复制 Agent 运行状态。
 */

import { cn } from "@/lib/utils";
import type { ChannelSnapshot } from "@/modules/channels/types";
import { useTranslation } from "react-i18next";

/** 在设置和通知入口使用相同的连接状态描述。 */
export function ConnectionStatus({ snapshot }: { snapshot: ChannelSnapshot }) {
  const { t } = useTranslation("channels");
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          snapshot.issue
            ? "bg-destructive"
            : snapshot.status === "online"
              ? "bg-emerald-500"
              : "bg-muted-foreground/50",
        )}
      />
      <span>
        {t(`status.${snapshot.status}`)}
        {snapshot.busy ? ` · ${t("busy")}` : ""}
        {snapshot.queued ? ` · ${t("queued", { count: snapshot.queued })}` : ""}
      </span>
    </span>
  );
}

/**
 * 本文件将消息连接加入既有 Agent 状态入口。
 * 点击通过服务打开该实例的对话列表，不另建聊天窗口。
 */

import { requestChannels, useChannelsView } from "@/modules/channels/client";
import { ConnectionStatus } from "@/modules/channels/components/ConnectionStatus";
import { Button } from "@/components/controls/button";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

/** 展示当前 Local 主窗口持有的连接，并提供不离开面板的启用或停用入口。 */
export function ChannelStatusRows({ onActivate }: { onActivate: () => void }) {
  const { t } = useTranslation("channels");
  const snapshots = useChannelsView((state) => state.snapshots);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const toggle = (id: string, enabled: boolean) => {
    if (pendingId) return;
    setPendingId(id);
    void requestChannels({ action: "enable", id, enabled })
      .catch(() => toast.error(t("errors.unavailable")))
      .finally(() => setPendingId(null));
  };

  if (!snapshots.length) return null;
  return (
    <div>
      <div className="px-2 pt-1 pb-0.5 text-[10px] font-medium text-muted-foreground">
        {t("title")}
      </div>
      {snapshots.map((snapshot) => (
        <div
          key={snapshot.connection.id}
          className="flex min-w-0 items-center gap-1 px-1"
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-1 py-1 text-left hover:bg-accent"
            onClick={() => {
              void requestChannels({
                action: "open",
                id: snapshot.connection.id,
              })
                .then(onActivate)
                .catch(() => toast.error(t("errors.unavailable")));
            }}
          >
            <span className="min-w-0 truncate text-[12px] text-muted-foreground">
              {snapshot.connection.name}
            </span>
            <ConnectionStatus
              snapshot={snapshot}
              className="w-24 shrink-0 justify-end"
            />
          </button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="w-14 shrink-0 justify-center"
            disabled={pendingId !== null || !snapshot.connection.accountId}
            aria-label={t(
              snapshot.connection.enabled ? "disconnect" : "connect",
              { name: snapshot.connection.name },
            )}
            onClick={() =>
              toggle(snapshot.connection.id, !snapshot.connection.enabled)
            }
          >
            {pendingId === snapshot.connection.id
              ? t("busy")
              : t(snapshot.connection.enabled ? "disconnect" : "connect")}
          </Button>
        </div>
      ))}
    </div>
  );
}

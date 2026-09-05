/**
 * 本文件将消息连接加入既有 Agent 状态入口。
 * 点击通过服务打开固定会话，不另建聊天窗口。
 */

import { requestChannels, useChannelsView } from "@/modules/channels/client";
import { ConnectionStatus } from "@/modules/channels/components/ConnectionStatus";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

/** 展示当前 Local 主窗口持有的连接，未配置时不占据弹层空间。 */
export function ChannelStatusRows({ onActivate }: { onActivate: () => void }) {
  const { t } = useTranslation("channels");
  const snapshots = useChannelsView((state) => state.snapshots);
  if (!snapshots.length) return null;
  return (
    <div className="border-b border-border/50 pb-1">
      <div className="px-2 py-1 text-[10px] text-muted-foreground">
        {t("title")}
      </div>
      {snapshots.map((snapshot) => (
        <button
          key={snapshot.connection.id}
          type="button"
          className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
          onClick={() => {
            void requestChannels({ action: "open", id: snapshot.connection.id })
              .then(onActivate)
              .catch(() => toast.error(t("errors.unavailable")));
          }}
        >
          <span className="min-w-0 truncate text-xs">
            {snapshot.connection.name}
          </span>
          <ConnectionStatus snapshot={snapshot} />
        </button>
      ))}
    </div>
  );
}

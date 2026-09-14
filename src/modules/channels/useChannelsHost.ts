/**
 * 本文件把 Channels 服务挂到 Local 永久 Workspace 生命周期。
 * 其余窗口不加载服务，Strict Mode 清理发生后不启动已失效的异步初始化。
 */

import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { currentWorkspaceBootstrap } from "@/modules/workspace-process";
import { useEffect } from "react";

// 异步初始化和清理串行，避免 Strict Mode 或快速重挂载产生两个服务。
let lifecycle: Promise<void> = Promise.resolve();

/** 仅应用根部调用，设置和聊天面板不拥有连接。 */
export function useChannelsHost(
  activate: (sessionId?: string) => void,
  keysLoaded: boolean,
): void {
  const sessionsReady = useChatStore((state) => state.sessionsHydrated);
  const preferencesReady = usePreferencesStore((state) => state.hydrated);
  const ready = keysLoaded && sessionsReady && preferencesReady;
  useEffect(() => {
    const bootstrap = currentWorkspaceBootstrap();
    if (!ready || !bootstrap.isPrimary || bootstrap.env.kind !== "local")
      return;
    let disposed = false;
    let stop: (() => Promise<void>) | undefined;
    lifecycle = lifecycle
      .then(async () => {
        if (disposed) return;
        const { startChannelsService } = await import(
          "@/modules/channels/service"
        );
        if (disposed) return;
        stop = await startChannelsService(activate);
      })
      .catch((error) => {
        console.error("Channels initialization failed", error);
      });
    return () => {
      disposed = true;
      lifecycle = lifecycle
        .then(async () => {
          await stop?.();
        })
        .catch((error) => {
          console.error("Channels cleanup failed", error);
        });
    };
  }, [activate, ready]);
}

/**
 * 主窗口消费原生保存的通知点击目标，业务入口通过回调解析模块身份。
 * 先订阅后读取，防止挂载期间漏掉事件；只有主窗口拥有消费权限。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import type { MainNotificationTarget } from "./client";

export function NotificationNavigationBridge({
  onActivate,
}: {
  onActivate: (target: MainNotificationTarget) => void;
}) {
  const activate = useRef(onActivate);
  activate.current = onActivate;
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    let pending = false;
    let consuming = false;
    const consume = async () => {
      pending = true;
      if (consuming || !alive) return;
      consuming = true;
      try {
        while (alive && pending) {
          pending = false;
          const activation = await invoke<{
            id: string;
            target: MainNotificationTarget;
          } | null>("notification_get_activation");
          if (!alive) return;
          if (activation) {
            activate.current(activation.target);
            await invoke("notification_ack_activation", { id: activation.id });
          }
        }
      } finally {
        consuming = false;
      }
    };
    void listen("terax:notification-activate", () => {
      void consume().catch(console.warn);
    })
      .then((stop) => {
        if (!alive) {
          stop();
          return;
        }
        unlisten = stop;
        return consume();
      })
      .catch(console.warn);
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);
  return null;
}

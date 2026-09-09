/**
 * 本文件提供 AI 会话等待与运行状态共用的波浪跳点。
 * 动画仅改变垂直位移、保持颜色不变，并由全局 reduced motion 规则关闭。
 */

import { cn } from "@/lib/utils";

/** 三个依次上跳的会话状态点，全部落下后停留 420ms 再开始下一轮。 */
export function ChatStatusDots({ className }: { className?: string }) {
  const dotClassName =
    "size-1 rounded-full bg-current motion-safe:animate-[terax-chat-dot-wave_1200ms_ease-in-out_infinite]";

  return (
    <span
      className={cn(
        "inline-flex h-3 items-center gap-1 text-foreground",
        className,
      )}
      aria-hidden="true"
    >
      <span className={dotClassName} />
      <span className={dotClassName} style={{ animationDelay: "120ms" }} />
      <span className={dotClassName} style={{ animationDelay: "240ms" }} />
    </span>
  );
}

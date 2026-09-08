/**
 * 本文件实现聊天消息中的推理分段展示。
 * 推理结束后保留展开内容，直到后继可见输出出现或整条消息结束，再立即收起一次。
 */

import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useProgressiveText } from "@/modules/ai/hooks/useProgressiveText";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

type ChatReasoningPartProps = {
  text: string;
  durationMs?: number;
  isStreaming: boolean;
  autoCollapse: boolean;
};

/**
 * 聊天推理分段。
 *
 * 自动收起只发生一次，完成后用户仍可重新展开；布局 effect 保证后继内容
 * 首次绘制时，旧推理块已经进入关闭态。
 */
export function ChatReasoningPart({
  text,
  durationMs,
  isStreaming,
  autoCollapse,
}: ChatReasoningPartProps) {
  const { t } = useTranslation("ai");
  const [isOpen, setIsOpen] = useState(!autoCollapse);
  const hasAutoCollapsed = useRef(autoCollapse);
  const visibleText = useProgressiveText(text, isStreaming && isOpen);
  const durationSeconds =
    durationMs === undefined
      ? undefined
      : Math.max(1, Math.ceil(durationMs / 1000));

  useLayoutEffect(() => {
    if (!autoCollapse || hasAutoCollapsed.current) return;
    hasAutoCollapsed.current = true;
    setIsOpen(false);
  }, [autoCollapse]);

  return (
    <Collapsible
      className="ai-reasoning-part not-prose"
      open={isOpen}
      onOpenChange={setIsOpen}
    >
      <CollapsibleTrigger className="flex items-center gap-1.5 text-[12px] leading-4 italic text-muted-foreground transition-colors duration-control hover:text-foreground">
        {isStreaming ? (
          <Shimmer sweepDuration={1.2} pauseDuration={0.6}>
            {t("chat.reasoning.thinking")}
          </Shimmer>
        ) : (
          <span>
            {durationSeconds === undefined
              ? t("chat.reasoning.completed")
              : t("chat.reasoning.completedWithDuration", {
                  duration: durationSeconds,
                })}
          </span>
        )}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={11}
          strokeWidth={1.75}
          className={cn(
            "transition-transform duration-control ease-emphasized",
            isOpen ? "rotate-180" : "rotate-0",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="terax-collapsible-content outline-none [&_*]:text-[12px]!">
        <div className="mt-1 ml-1 border-l border-border/50 pl-3 text-[11.5px] leading-relaxed text-muted-foreground whitespace-pre-wrap wrap-break-word">
          {visibleText}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

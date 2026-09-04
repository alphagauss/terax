/**
 * 本文件实现 AI 会话的恢复跟随按钮和用户消息快速导航菜单。
 * 控件仅在脱离底部时挂载，运行态使用共用波浪跳点，菜单延迟展开并按需生成摘要。
 */

import { cn } from "@/lib/utils";
import { ArrowDown02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStickToBottomContext } from "use-stick-to-bottom";
import {
  buildUserMessageAnchors,
  CHAT_SCROLL_SPRING,
  shouldShowChatScrollControls,
  type UserMessageAnchor,
} from "../lib/chatScroll";
import { ChatStatusDots } from "./ChatStatusDots";

const MENU_OPEN_DELAY_MS = 1000;
const MENU_CLOSE_DELAY_MS = 400;

function conversationMessageElement(
  scrollElement: HTMLElement,
  messageId: string,
): HTMLElement | null {
  return (
    Array.from(
      scrollElement.querySelectorAll<HTMLElement>(
        "[data-conversation-message-id]",
      ),
    ).find((element) => element.dataset.conversationMessageId === messageId) ??
    null
  );
}

/**
 * AI 会话滚动与消息导航控件。
 *
 * 用户滚轮脱离流式跟随后显示跳动点，点击后以同一 rAF 弹簧恢复到底部；
 * 悬停一秒或键盘聚焦时展开用户消息列表。
 */
export function AiChatScrollControls({
  messages,
  running,
}: {
  messages: UIMessage[];
  running: boolean;
}) {
  const { t } = useTranslation("ai");
  const { isAtBottom, scrollRef, scrollToBottom, stopScroll } =
    useStickToBottomContext();
  const [panelOpen, setPanelOpen] = useState(false);
  const [userMessages, setUserMessages] = useState<UserMessageAnchor[]>([]);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const visible = shouldShowChatScrollControls(isAtBottom);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const openPanel = useCallback(() => {
    clearTimers();
    setUserMessages(
      buildUserMessageAnchors(messages, t("chat.userMessageFallback")),
    );
    setPanelOpen(true);
  }, [clearTimers, messages, t]);

  const closePanel = useCallback(() => {
    clearTimers();
    setPanelOpen(false);
  }, [clearTimers]);

  useEffect(
    () => () => {
      clearTimers();
    },
    [clearTimers],
  );

  useEffect(() => {
    if (!visible) {
      setPanelOpen(false);
      setUserMessages([]);
    }
  }, [visible]);

  if (!visible) {
    return null;
  }

  const handleMouseEnter = () => {
    clearTimers();
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      openPanel();
    }, MENU_OPEN_DELAY_MS);
  };

  const handleMouseLeave = () => {
    clearTimers();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setPanelOpen(false);
    }, MENU_CLOSE_DELAY_MS);
  };

  const handleJumpToBottom = () => {
    closePanel();
    void scrollToBottom({
      animation: CHAT_SCROLL_SPRING,
      ignoreEscapes: true,
    });
  };

  const handleJumpToMessage = (messageId: string) => {
    const scrollElement = scrollRef.current;
    const messageElement = scrollElement
      ? conversationMessageElement(scrollElement, messageId)
      : null;
    closePanel();
    if (!scrollElement || !messageElement) {
      return;
    }

    stopScroll();
    const containerRect = scrollElement.getBoundingClientRect();
    const messageRect = messageElement.getBoundingClientRect();
    const targetTop = Math.max(
      0,
      scrollElement.scrollTop + messageRect.top - containerRect.top - 12,
    );
    scrollElement.scrollTo({
      top: targetTop,
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  };

  return (
    <fieldset
      aria-label={t("chat.scrollNavigation")}
      className="absolute bottom-3 left-1/2 z-30 m-0 flex min-w-0 -translate-x-1/2 flex-col items-center gap-2 border-0 p-0"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocusCapture={openPanel}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          closePanel();
        }
      }}
    >
      {panelOpen && userMessages.length > 0 ? (
        <div className="w-72 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-border/70 bg-background/95 shadow-xl backdrop-blur animate-in fade-in-0 zoom-in-95 duration-control ease-emphasized">
          <div className="border-b border-border/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {t("chat.recentUserMessages")}
          </div>
          <div className="app-scrollbar max-h-64 overflow-y-auto p-1.5">
            <div className="space-y-1">
              {userMessages.map((message) => (
                <button
                  key={message.id}
                  type="button"
                  onClick={() => handleJumpToMessage(message.id)}
                  className="group flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-[11.5px] leading-relaxed text-foreground transition-colors duration-control hover:bg-interactive-hover"
                >
                  <span className="mt-0.5 shrink-0 rounded-full bg-muted/60 px-1.5 py-0.5 text-[9.5px] font-medium text-muted-foreground transition-colors duration-control group-hover:text-foreground">
                    {message.index + 1}
                  </span>
                  <span className="line-clamp-2 min-w-0 flex-1 break-words text-muted-foreground">
                    {message.text}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        onClick={handleJumpToBottom}
        className={cn(
          "flex size-8 items-center justify-center rounded-full border border-border/60 bg-background/90 shadow-md backdrop-blur",
          "text-foreground transition-colors duration-control hover:bg-muted",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
        aria-label={t("chat.scrollToLatest")}
      >
        {running ? (
          <ChatStatusDots />
        ) : (
          <HugeiconsIcon icon={ArrowDown02Icon} size={14} strokeWidth={2} />
        )}
      </button>
    </fieldset>
  );
}

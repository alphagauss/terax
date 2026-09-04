/**
 * 本文件保护 AI 会话中用户主动浏览的滚动位置。
 * 用户主动展开或收起详情时暂停底部跟随，避免尺寸动画移动阅读位置。
 */

import { useEffect, useRef } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";

/**
 * 聊天折叠详情滚动保护组件。
 *
 * 点击折叠入口后立即暂停跟随，并在最终尺寸提交后再次确认暂停。
 * 用户主动回到底部或点击“前往最新输出”后，现有会话逻辑可以恢复跟随。
 */
export function ChatCollapsibleScrollGuard() {
  const { scrollRef, stopScroll } = useStickToBottomContext();
  const preserveDetachedRef = useRef(false);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const trigger = target.closest("[data-slot='collapsible-trigger']");
      if (!trigger || !scrollElement.contains(trigger)) return;

      preserveDetachedRef.current = true;
      stopScroll();
    };

    const handleAnimationFinished = (event: AnimationEvent) => {
      const target = event.target;
      if (
        !preserveDetachedRef.current ||
        !(target instanceof Element) ||
        !target.classList.contains("terax-collapsible-content")
      ) {
        return;
      }

      window.requestAnimationFrame(() => {
        if (!preserveDetachedRef.current) return;
        preserveDetachedRef.current = false;
        stopScroll();
      });
    };

    scrollElement.addEventListener("click", handleClick, true);
    scrollElement.addEventListener(
      "animationend",
      handleAnimationFinished,
      true,
    );
    scrollElement.addEventListener(
      "animationcancel",
      handleAnimationFinished,
      true,
    );
    return () => {
      scrollElement.removeEventListener("click", handleClick, true);
      scrollElement.removeEventListener(
        "animationend",
        handleAnimationFinished,
        true,
      );
      scrollElement.removeEventListener(
        "animationcancel",
        handleAnimationFinished,
        true,
      );
    };
  }, [scrollRef, stopScroll]);

  return null;
}

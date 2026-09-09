/**
 * 本文件保护 AI 会话中用户主动浏览的滚动位置。
 * 用户主动展开、收起详情或切换标签时暂停底部跟随，避免尺寸动画移动阅读位置。
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
  const { scrollRef, contentRef, stopScroll } = useStickToBottomContext();
  const preserveDetachedRef = useRef(false);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    const contentElement = contentRef.current;
    if (!scrollElement || !contentElement) return;
    const clickRoot = scrollElement.parentElement ?? scrollElement;
    const originalMinHeight = contentElement.style.minHeight;
    const originalAnchor = scrollElement.style.overflowAnchor;
    const releaseSpace = () => {
      contentElement.style.minHeight = originalMinHeight;
      scrollElement.style.overflowAnchor = originalAnchor;
    };

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-chat-scroll-resume]")) {
        preserveDetachedRef.current = false;
        releaseSpace();
        return;
      }
      const trigger = target.closest(
        "[data-slot='collapsible-trigger'], [data-chat-scroll-preserve]",
      );
      if (!trigger || !scrollElement.contains(trigger)) return;

      // 收起导致滚动范围变小时，单独 stopScroll 无法阻止浏览器钳制 scrollTop。
      // 临时保留视口所需空间，额外 1px 对齐底部跟随库的余量；不保留卡片内部空白。
      contentElement.style.minHeight = `${Math.ceil(scrollElement.scrollTop + scrollElement.clientHeight + 1)}px`;
      scrollElement.style.overflowAnchor = "none";
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

    clickRoot.addEventListener("click", handleClick, true);
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
      releaseSpace();
      clickRoot.removeEventListener("click", handleClick, true);
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
  }, [scrollRef, contentRef, stopScroll]);

  return null;
}

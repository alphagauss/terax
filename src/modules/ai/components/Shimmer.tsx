/**
 * 本文件提供活动标题的合成层扫光。
 * 遮罩随光带平移，文字反向平移保持位置不变；避免逐帧重新绘制文字背景。
 */
import { createElement, memo, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import "./Shimmer.css";

/** 仅用于运行中的短标题，结束或隐藏时由宿主卸载动画图层。 */
export const Shimmer = memo(function Shimmer({
  children,
  as = "p",
  className,
}: {
  children: string;
  as?: "p" | "span";
  className?: string;
}) {
  return createElement(
    as,
    {
      className: cn("ai-shimmer", className),
      style: {
        // 摘要会被单行省略，光带不随不可见文本无限增宽。
        "--shimmer-spread": `${Math.min(children.length * 2, 80)}px`,
      } as CSSProperties,
    },
    children,
    <span className="ai-shimmer-light" aria-hidden="true">
      <span className="ai-shimmer-text" data-text={children} />
    </span>,
  );
});

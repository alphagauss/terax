/**
 * 本文件提供跨业务复用的合成层文字扫光。
 * 遮罩随光带平移，文字反向平移保持位置不变，避免逐帧重绘文字背景。
 */

import { cn } from "@/lib/utils";
import { type CSSProperties, createElement, memo, type ReactNode } from "react";
import "./shimmer.css";

/** 仅用于可见的运行中短标题，结束或隐藏时由宿主卸载动画图层。 */
export const Shimmer = memo(function Shimmer({
  children,
  as = "p",
  className,
  text,
}: {
  children: ReactNode;
  as?: "p" | "span";
  className?: string;
  text?: string;
}) {
  const plainText = typeof children === "string" ? children : undefined;
  const shimmerText = text ?? plainText ?? "";

  return createElement(
    as,
    {
      className: cn("terax-shimmer", className),
      style: {
        // 摘要会被单行省略，光带不随不可见文本无限增宽。
        "--shimmer-spread": `${Math.min(shimmerText.length * 2, 80)}px`,
      } as CSSProperties,
    },
    children,
    <span className="terax-shimmer-light" aria-hidden="true">
      <span className="terax-shimmer-text" data-text={plainText}>
        {plainText === undefined ? children : null}
      </span>
    </span>,
  );
});

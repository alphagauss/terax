"use client";

/**
 * 本文件实现可配置扫光与停顿节奏的文字流光组件。
 * 每轮动画由扫光阶段和末尾停顿阶段组成，非法时长会回退到默认值。
 */

import { cn } from "@/lib/utils";
import type { CSSProperties, ElementType } from "react";
import { createElement, memo, useMemo } from "react";

/** 文字流光的内容、宿主元素和动画参数。 */
export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  sweepDuration?: number;
  pauseDuration?: number;
  spread?: number;
}

const DEFAULT_SWEEP_DURATION_SECONDS = 1.2;
const DEFAULT_PAUSE_DURATION_SECONDS = 0.6;

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  sweepDuration = DEFAULT_SWEEP_DURATION_SECONDS,
  pauseDuration = DEFAULT_PAUSE_DURATION_SECONDS,
  spread = 2,
}: TextShimmerProps) => {
  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread],
  );
  const normalizedSweepDuration =
    Number.isFinite(sweepDuration) && sweepDuration > 0
      ? sweepDuration
      : DEFAULT_SWEEP_DURATION_SECONDS;
  const normalizedPauseDuration =
    Number.isFinite(pauseDuration) && pauseDuration >= 0
      ? pauseDuration
      : DEFAULT_PAUSE_DURATION_SECONDS;
  const cycleDuration = normalizedSweepDuration + normalizedPauseDuration;
  const sweepEnd = (normalizedSweepDuration / cycleDuration) * 100;

  return createElement(
    Component,
    {
      className: cn(
        "terax-shimmer relative inline-block bg-clip-text text-transparent",
        className,
      ),
      style: {
        "--shimmer-spread": `${dynamicSpread}px`,
        "--shimmer-cycle-duration": `${cycleDuration}s`,
        "--shimmer-sweep-end": `${sweepEnd}%`,
      } as CSSProperties,
    },
    children,
  );
};

export const Shimmer = memo(ShimmerComponent);

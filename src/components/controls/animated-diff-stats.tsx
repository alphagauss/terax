/** 共用增删行数展示，数字变化时沿用文件编辑工具的上下滚动动画。 */
import { useState } from "react";
import "./animated-diff-stats.css";

export function AnimatedDiffStats({
  stats,
  animate = true,
}: {
  stats: { added: number; removed: number };
  animate?: boolean;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
      <RollingNumber
        value={stats.added}
        direction="up"
        prefix="+"
        animate={animate}
      />
      <RollingNumber
        value={stats.removed}
        direction="down"
        prefix="-"
        animate={animate}
      />
    </span>
  );
}

function RollingNumber({
  value,
  direction,
  prefix,
  animate,
}: {
  value: number;
  direction: "up" | "down";
  prefix: string;
  animate: boolean;
}) {
  const [pair, setPair] = useState({ previous: value, current: value });
  if (pair.current !== value)
    setPair({ previous: pair.current, current: value });
  const moving = animate && pair.previous !== pair.current;
  return (
    <span
      className={`file-edit-number ${direction === "up" ? "text-success" : "text-destructive"}`}
      data-direction={direction}
    >
      <span
        key={value}
        className={moving ? "file-edit-number-motion" : undefined}
      >
        {moving && (
          <span aria-hidden className="file-edit-number-old">
            {prefix}
            {pair.previous}
          </span>
        )}
        <span className="file-edit-number-new">
          {prefix}
          {value}
        </span>
      </span>
    </span>
  );
}

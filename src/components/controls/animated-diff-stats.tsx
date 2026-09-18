/** 共用增删行数展示，数字变化时使用短距离滚动动画。 */
import { useLayoutEffect, useState } from "react";
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
  useLayoutEffect(() => {
    setPair((current) =>
      current.current === value
        ? current
        : { previous: current.current, current: value },
    );
  }, [value]);
  const moving = animate && pair.previous !== pair.current;
  return (
    <span
      className={`file-edit-number ${direction === "up" ? "text-success" : "text-destructive"}`}
      data-direction={direction}
    >
      <span
        key={value}
        className={moving ? "file-edit-number-motion" : undefined}
        onAnimationEnd={() =>
          setPair((current) =>
            current.current !== value || current.previous === current.current
              ? current
              : { previous: value, current: value },
          )
        }
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

/** 三栏内部的宽度调整手柄，拖动只移动预览线，松手后一次提交图表尺寸。 */
import { useRef } from "react";

export function AlphaDeskDivider({
  label,
  width,
  reverse = false,
  onCommit,
}: {
  label: string;
  width: number;
  reverse?: boolean;
  onCommit: (width: number) => void;
}) {
  const preview = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ start: number; width: number; next: number } | null>(
    null,
  );
  const clamp = (value: number) =>
    Math.max(200, Math.min(480, Math.round(value)));
  const reset = () => {
    drag.current = null;
    if (preview.current) {
      preview.current.style.transform = "";
      preview.current.style.visibility = "hidden";
    }
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: 可聚焦的交互分隔条包含拖动预览，不是静态水平线。
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={200}
      aria-valuemax={480}
      aria-valuenow={width}
      className="relative z-10 w-px shrink-0 cursor-col-resize touch-none bg-border outline-none after:absolute after:inset-y-0 after:-left-1 after:w-2 focus-visible:bg-primary"
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        onCommit(
          clamp(
            width +
              (event.key === "ArrowRight" ? 16 : -16) * (reverse ? -1 : 1),
          ),
        );
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { start: event.clientX, width, next: width };
        if (preview.current) preview.current.style.visibility = "visible";
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current) return;
        current.next = clamp(
          current.width + (event.clientX - current.start) * (reverse ? -1 : 1),
        );
        if (preview.current)
          preview.current.style.transform = `translateX(${(current.next - current.width) * (reverse ? -1 : 1)}px)`;
      }}
      onPointerUp={(event) => {
        const next = drag.current?.next;
        reset();
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        if (next !== undefined && next !== width) onCommit(next);
      }}
      onPointerCancel={reset}
      onLostPointerCapture={reset}
    >
      <span
        ref={preview}
        className="pointer-events-none absolute inset-y-0 left-0 invisible w-px bg-primary"
      />
    </div>
  );
}

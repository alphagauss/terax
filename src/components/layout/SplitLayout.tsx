/** 通用面板分割容器：拖动只更新预览，提交尺寸由业务持久化，内容实例保持挂载。 */
import {
  createContext,
  useContext,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

const SplitDirection = createContext<"horizontal" | "vertical">("horizontal");

/** 固定分区的可嵌套容器；不拥有业务状态或存储，尺寸单位为像素。 */
export function SplitLayout({
  direction = "horizontal",
  children,
  className,
  ...props
}: ComponentProps<"div"> & { direction?: "horizontal" | "vertical" }) {
  return (
    <SplitDirection value={direction}>
      <div
        {...props}
        className={cn(
          "flex min-h-0 min-w-0",
          direction === "vertical" && "flex-col",
          className,
        )}
      >
        {children}
      </div>
    </SplitDirection>
  );
}

/** 稳定的业务内容容器；收起仅隐藏内容，保留子组件实例和展开尺寸。 */
export function SplitPanel({
  id,
  size,
  open = true,
  children,
  className,
}: {
  id: string;
  size?: number;
  open?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const direction = useContext(SplitDirection);
  return (
    <div
      id={id}
      hidden={!open}
      inert={!open}
      className={cn(
        "min-h-0 min-w-0 overflow-hidden",
        size === undefined ? "flex-1" : "shrink-0",
        className,
        !open && "hidden",
      )}
      style={
        size === undefined
          ? undefined
          : { [direction === "horizontal" ? "width" : "height"]: size }
      }
    >
      {children}
    </div>
  );
}

/** 相邻分区的交互边界，支持键盘、双击复位和取消拖动。 */
export function ResizeHandle({
  label,
  size,
  minSize = 200,
  maxSize = 480,
  defaultSize,
  panelId,
  reverse = false,
  onCommit,
}: {
  label: string;
  size: number;
  minSize?: number;
  maxSize?: number;
  defaultSize: number;
  panelId: string;
  reverse?: boolean;
  onCommit: (size: number) => void;
}) {
  const direction = useContext(SplitDirection);
  const horizontal = direction === "horizontal";
  const handle = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLSpanElement>(null);
  const drag = useRef<{
    pointerId: number;
    start: number;
    size: number;
    next: number;
  } | null>(null);
  const clamp = (value: number) =>
    Math.max(minSize, Math.min(maxSize, Math.round(value)));
  const reset = () => {
    const pointerId = drag.current?.pointerId;
    drag.current = null;
    if (
      pointerId !== undefined &&
      handle.current?.hasPointerCapture(pointerId)
    ) {
      handle.current.releasePointerCapture(pointerId);
    }
    if (preview.current) {
      preview.current.style.transform = "";
      preview.current.style.visibility = "hidden";
    }
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: 可聚焦的交互分隔条包含拖动预览，不是静态水平线。
    <div
      ref={handle}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-controls={panelId}
      onDoubleClick={() => onCommit(clamp(defaultSize))}
      aria-valuemin={minSize}
      aria-valuemax={maxSize}
      aria-valuenow={size}
      className={cn(
        "relative z-30 shrink-0 touch-none bg-border outline-none after:absolute focus-visible:bg-primary",
        horizontal
          ? "w-px cursor-col-resize after:inset-y-0 after:-left-1 after:w-2"
          : "h-px cursor-row-resize after:inset-x-0 after:-top-1 after:h-2",
      )}
      onKeyDown={(event) => {
        if (event.key === "Escape" && drag.current) {
          event.preventDefault();
          event.stopPropagation();
          reset();
          return;
        }
        const decrease = horizontal ? "ArrowLeft" : "ArrowUp";
        const increase = horizontal ? "ArrowRight" : "ArrowDown";
        if (
          event.key !== decrease &&
          event.key !== increase &&
          event.key !== "Home" &&
          event.key !== "End"
        )
          return;
        event.preventDefault();
        reset();
        onCommit(
          event.key === "Home"
            ? minSize
            : event.key === "End"
              ? maxSize
              : clamp(
                  size +
                    (event.key === increase ? 16 : -16) * (reverse ? -1 : 1),
                ),
        );
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId,
          start: horizontal ? event.clientX : event.clientY,
          size,
          next: size,
        };
        if (preview.current) preview.current.style.visibility = "visible";
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || event.pointerId !== current.pointerId) return;
        current.next = clamp(
          current.size +
            ((horizontal ? event.clientX : event.clientY) - current.start) *
              (reverse ? -1 : 1),
        );
        if (preview.current)
          preview.current.style.transform = `translate${horizontal ? "X" : "Y"}(${(current.next - current.size) * (reverse ? -1 : 1)}px)`;
      }}
      onPointerUp={(event) => {
        if (event.pointerId !== drag.current?.pointerId) return;
        const next = drag.current.next;
        reset();
        if (next !== undefined && next !== size) onCommit(next);
      }}
      onPointerCancel={(event) => {
        if (event.pointerId === drag.current?.pointerId) reset();
      }}
      onLostPointerCapture={(event) => {
        if (event.pointerId === drag.current?.pointerId) reset();
      }}
      onBlur={reset}
    >
      <span
        ref={preview}
        className={cn(
          "pointer-events-none absolute invisible bg-primary",
          horizontal ? "inset-y-0 left-0 w-px" : "inset-x-0 top-0 h-px",
        )}
      />
    </div>
  );
}

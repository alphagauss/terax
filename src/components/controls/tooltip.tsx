/**
 * 桌面悬停提示的统一入口，固定延迟、主题、动效和窗口失活行为。
 * Provider 定义免等待分组；Hint 用于单个元素，复合内容使用 Tooltip 系列组件。
 */
import {
  Tooltip as BaseTooltip,
  TooltipContent as BaseTooltipContent,
  TooltipProvider as BaseTooltipProvider,
  TooltipTrigger as BaseTooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { Slot } from "radix-ui";
import {
  type ComponentProps,
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

type TooltipGroupValue = {
  dismissEpoch: number;
  suspended: { current: boolean };
  lastClosedAt: { current: number };
};

type TooltipInstanceValue = {
  hover: (element: HTMLElement) => void;
  leave: () => void;
  dismiss: () => void;
};

const TooltipGroup = createContext<TooltipGroupValue | null>(null);
const TooltipInstance = createContext<TooltipInstanceValue | null>(null);
// 独立延迟分组仍共用一个可见提示，避免跨面板移动时叠加。
let activeTooltip:
  | { dismiss: () => void; group: TooltipGroupValue }
  | undefined;

export const TOOLTIP_DELAY_MS = 800;
export const TOOLTIP_SKIP_DELAY_MS = 500;

export function TooltipProvider({ children }: { children: ReactNode }) {
  const suspended = useRef(typeof document !== "undefined" && document.hidden);
  const lastClosedAt = useRef(Number.NEGATIVE_INFINITY);
  const [dismissEpoch, setDismissEpoch] = useState(0);

  useEffect(() => {
    const suspend = () => {
      suspended.current = true;
      lastClosedAt.current = Number.NEGATIVE_INFINITY;
      setDismissEpoch((value) => value + 1);
    };
    const onVisibilityChange = () => {
      if (document.hidden) suspend();
    };
    window.addEventListener("blur", suspend);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", suspend);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const group = useMemo(
    () => ({ dismissEpoch, suspended, lastClosedAt }),
    [dismissEpoch],
  );
  return (
    <TooltipGroup value={group}>
      <BaseTooltipProvider>{children}</BaseTooltipProvider>
    </TooltipGroup>
  );
}

export function Tooltip(
  props: Omit<ComponentProps<typeof BaseTooltip>, "delayDuration">,
) {
  const grouped = useContext(TooltipGroup);
  if (grouped) return <GroupedTooltip group={grouped} {...props} />;
  return (
    <TooltipProvider>
      <Tooltip {...props} />
    </TooltipProvider>
  );
}

function GroupedTooltip({
  group,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  ...props
}: Omit<ComponentProps<typeof BaseTooltip>, "delayDuration"> & {
  group: TooltipGroupValue;
}) {
  const [open, setOpen] = useControllableState({
    prop: controlledOpen,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
    caller: "Tooltip",
  });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hovered = useRef(false);
  const handledDismissEpoch = useRef(group.dismissEpoch);
  const leave = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    hovered.current = false;
  }, []);
  const dismiss = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setOpen(false);
  }, [setOpen]);

  useEffect(() => {
    if (handledDismissEpoch.current === group.dismissEpoch) return;
    handledDismissEpoch.current = group.dismissEpoch;
    leave();
    dismiss();
  }, [group.dismissEpoch, leave, dismiss]);
  useEffect(() => leave, [leave]);

  useEffect(() => {
    if (!open) return;
    activeTooltip?.dismiss();
    activeTooltip = { dismiss, group };
    return () => {
      if (activeTooltip?.dismiss === dismiss) activeTooltip = undefined;
      if (!group.suspended.current) group.lastClosedAt.current = Date.now();
    };
  }, [open, dismiss, group]);

  const hover = useCallback(
    (element: HTMLElement) => {
      if (document.hidden || isExpandedPopup(element)) {
        dismiss();
        return;
      }
      group.suspended.current = false;
      if (hovered.current) return;
      hovered.current = true;
      const show = () => {
        timer.current = undefined;
        if (!group.suspended.current && !isExpandedPopup(element))
          setOpen(true);
      };
      if (
        activeTooltip?.group === group ||
        Date.now() - group.lastClosedAt.current < TOOLTIP_SKIP_DELAY_MS
      )
        show();
      else timer.current = setTimeout(show, TOOLTIP_DELAY_MS);
    },
    [group, setOpen, dismiss],
  );
  const instance = useMemo(
    () => ({ hover, leave, dismiss }),
    [hover, leave, dismiss],
  );

  return (
    <TooltipInstance value={instance}>
      <BaseTooltip
        {...props}
        open={open}
        onOpenChange={(next) => {
          if (!next) dismiss();
        }}
      />
    </TooltipInstance>
  );
}

function isExpandedPopup(element: HTMLElement) {
  return (
    element.hasAttribute("aria-haspopup") &&
    element.getAttribute("aria-expanded") === "true"
  );
}

export function TooltipContent({
  className,
  ...props
}: ComponentProps<typeof BaseTooltipContent>) {
  return (
    <BaseTooltipContent
      className={cn(
        "border border-border/70 bg-zinc-50 text-[10.5px] text-zinc-950 shadow-lg shadow-black/30 dark:border-border/60 dark:bg-zinc-950 dark:text-zinc-100",
        "**:data-[slot=kbd]:bg-foreground/10 **:data-[slot=kbd]:text-inherit",
        className,
      )}
      {...props}
    />
  );
}

/** 列表共享一个提示实例，目标元素保持原有 DOM 和点击生命周期。 */
export function TargetTooltip({
  target,
  children,
}: {
  target: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TargetTooltipAnchor target={target} />
      {target && <TooltipContent side="top">{children}</TooltipContent>}
    </Tooltip>
  );
}

function TargetTooltipAnchor({ target }: { target: HTMLElement | null }) {
  const instance = useContext(TooltipInstance);
  const anchor = useRef<HTMLSpanElement>(null);
  const previousTarget = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // 窗口失活更新分组时只关闭，不能因目标未变重新启动悬停计时。
    const changed = previousTarget.current !== target;
    previousTarget.current = target;
    if (!target?.isConnected || !anchor.current || !instance) return;
    let needsPosition = true;
    const position = () => {
      if (!needsPosition || !anchor.current) return;
      const rect = target.getBoundingClientRect();
      Object.assign(anchor.current.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      needsPosition = false;
    };
    position();
    if (changed) instance.hover(target);
    const hover = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      position();
      instance.hover(target);
    };
    const dismiss = () => {
      needsPosition = true;
      instance.leave();
      instance.dismiss();
    };
    target.addEventListener("pointermove", hover);
    target.addEventListener("pointerleave", dismiss);
    target.addEventListener("pointerdown", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      dismiss();
      target.removeEventListener("pointermove", hover);
      target.removeEventListener("pointerleave", dismiss);
      target.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [target, instance]);
  // 侧栏的位移动画会建立 fixed 包含块，锚点与弹层同放 body 才能使用视口坐标。
  return createPortal(
    <TooltipTrigger asChild>
      <span ref={anchor} aria-hidden className="pointer-events-none fixed" />
    </TooltipTrigger>,
    document.body,
  );
}

/** 只由鼠标悬停打开提示；禁用按钮仍可解释原因，焦点和点击继续传给业务控件。 */
export function TooltipTrigger({
  className,
  onFocus,
  onPointerMove,
  onPointerLeave,
  onPointerDown,
  onClick,
  ...props
}: ComponentProps<typeof BaseTooltipTrigger>) {
  const instance = useContext(TooltipInstance);
  const popupExpanded =
    Boolean(props["aria-haspopup"]) &&
    String(props["aria-expanded"]) === "true";
  useEffect(() => {
    if (popupExpanded) instance?.dismiss();
  }, [popupExpanded, instance]);
  return (
    <BaseTooltipTrigger
      {...props}
      className={cn("disabled:pointer-events-auto!", className)}
      onFocus={(event) => {
        onFocus?.(event);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        if (!event.defaultPrevented && event.pointerType === "mouse") {
          instance?.hover(event.currentTarget);
        }
        // 悬停计时由项目拥有，窗口失活可直接取消，不派发模拟焦点事件。
        event.preventDefault();
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event);
        instance?.leave();
      }}
      onClick={(event) => {
        onClick?.(event);
        instance?.dismiss();
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        instance?.dismiss();
      }}
    />
  );
}

/** 不增加普通触发元素的 DOM 层级，并透传外层菜单触发器的事件和 ref。 */
export function Hint({
  content,
  children,
  side,
  ...props
}: Omit<ComponentProps<typeof Slot.Root>, "children" | "content"> & {
  content?: ReactNode;
  children: ReactElement;
  side?: ComponentProps<typeof TooltipContent>["side"];
}) {
  const trigger = <Slot.Root {...props}>{children}</Slot.Root>;
  if (content == null || content === "") return trigger;
  return (
    <Tooltip>
      <TooltipTrigger
        asChild
        aria-haspopup={props["aria-haspopup"]}
        aria-expanded={props["aria-expanded"]}
      >
        {trigger}
      </TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </Tooltip>
  );
}

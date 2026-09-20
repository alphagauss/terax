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
  type Ref,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type TooltipGroupValue = {
  dismissEpoch: number;
  canOpen: () => boolean;
};

type TooltipInstanceValue = {
  trigger: RefObject<HTMLElement | null>;
};

const TooltipGroup = createContext<TooltipGroupValue | null>(null);
const TooltipInstance = createContext<TooltipInstanceValue | null>(null);

export const TOOLTIP_DELAY_MS = 800;
export const TOOLTIP_SKIP_DELAY_MS = 500;

export function TooltipProvider({ children }: { children: ReactNode }) {
  const suspended = useRef(typeof document !== "undefined" && document.hidden);
  const [dismissEpoch, setDismissEpoch] = useState(0);

  useEffect(() => {
    const suspend = () => {
      suspended.current = true;
      setDismissEpoch((value) => value + 1);
    };
    const resumeFromInput = () => {
      suspended.current = false;
    };
    const onVisibilityChange = () => {
      if (document.hidden) suspend();
    };
    const suppressRestoredFocus = (event: FocusEvent) => {
      // WebView 恢复时会重新派发旧 activeElement 的焦点事件，不能把它当作键盘导航。
      if (suspended.current) event.stopImmediatePropagation();
    };

    window.addEventListener("blur", suspend);
    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("focusin", suppressRestoredFocus, true);
    document.addEventListener("pointermove", resumeFromInput, true);
    document.addEventListener("pointerdown", resumeFromInput, true);
    document.addEventListener("keydown", resumeFromInput, true);
    return () => {
      window.removeEventListener("blur", suspend);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("focusin", suppressRestoredFocus, true);
      document.removeEventListener("pointermove", resumeFromInput, true);
      document.removeEventListener("pointerdown", resumeFromInput, true);
      document.removeEventListener("keydown", resumeFromInput, true);
    };
  }, []);

  const canOpen = useCallback(() => !suspended.current, []);
  const group = useMemo(
    () => ({ dismissEpoch, canOpen }),
    [dismissEpoch, canOpen],
  );

  return (
    <TooltipGroup value={group}>
      <BaseTooltipProvider
        delayDuration={TOOLTIP_DELAY_MS}
        skipDelayDuration={TOOLTIP_SKIP_DELAY_MS}
      >
        {children}
      </BaseTooltipProvider>
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
  const trigger = useRef<HTMLElement | null>(null);
  const handledDismissEpoch = useRef(0);
  const instance = useMemo(() => ({ trigger }), []);

  useEffect(() => {
    if (group.dismissEpoch <= handledDismissEpoch.current) return;
    handledDismissEpoch.current = group.dismissEpoch;
    if (!open) return;
    const element = trigger.current;
    if (!element) {
      setOpen(false);
      return;
    }
    // 走 Radix 自身的 blur 关闭路径以同步分组计时，但不改变真实 DOM 焦点。
    const event = new FocusEvent("focusout", {
      bubbles: true,
      relatedTarget: null,
    });
    element.dispatchEvent(event);
  }, [group.dismissEpoch, open, setOpen]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next || group.canOpen()) setOpen(next);
    },
    [group, setOpen],
  );

  return (
    <TooltipInstance value={instance}>
      <BaseTooltip {...props} open={open} onOpenChange={handleOpenChange} />
    </TooltipInstance>
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

/** 禁用按钮仍响应指针悬停；点击和键盘禁用继续由原生 disabled 保证。 */
export function TooltipTrigger({
  className,
  ref,
  ...props
}: ComponentProps<typeof BaseTooltipTrigger>) {
  const instance = useContext(TooltipInstance);
  const handleRef = useCallback(
    (node: HTMLButtonElement | null) => {
      if (instance) instance.trigger.current = node;
      setRef(ref, node);
    },
    [instance, ref],
  );
  return (
    <BaseTooltipTrigger
      className={cn("disabled:pointer-events-auto!", className)}
      ref={handleRef}
      {...props}
    />
  );
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
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
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 桌面悬停提示的统一入口，固定延迟、主题与动效。
 * Provider 定义免等待分组；Hint 用于单个元素，复合内容使用 Tooltip 系列组件。
 */
import {
  Tooltip as BaseTooltip,
  TooltipContent as BaseTooltipContent,
  TooltipProvider as BaseTooltipProvider,
  TooltipTrigger as BaseTooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Slot } from "radix-ui";
import {
  createContext,
  useContext,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";

const TooltipGroup = createContext(false);

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipGroup value={true}>
      <BaseTooltipProvider delayDuration={800} skipDelayDuration={500}>
        {children}
      </BaseTooltipProvider>
    </TooltipGroup>
  );
}

export function Tooltip(
  props: Omit<ComponentProps<typeof BaseTooltip>, "delayDuration">,
) {
  const grouped = useContext(TooltipGroup);
  const tooltip = <BaseTooltip {...props} />;
  return grouped ? tooltip : <TooltipProvider>{tooltip}</TooltipProvider>;
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
  ...props
}: ComponentProps<typeof BaseTooltipTrigger>) {
  return (
    <BaseTooltipTrigger
      className={cn("disabled:pointer-events-auto!", className)}
      {...props}
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
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </Tooltip>
  );
}

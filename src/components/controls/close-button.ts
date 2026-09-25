/** 窗口与弹层共用关闭反馈，弹层使用更紧凑的点击区域。 */
import { cn } from "@/lib/utils";

export const closeIconButtonClassName =
  "grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive";

export const dialogCloseIconButtonClassName = cn(
  closeIconButtonClassName,
  "size-6",
);

import { Button, type ButtonProps } from "@/components/controls/button";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

/** 自选区退出临时操作的统一入口，以主题强调色描边区别普通工具和提交操作。 */
export function WatchlistCancelButton({
  children,
  ...props
}: Omit<ButtonProps, "variant" | "size" | "className">) {
  return (
    <Button
      {...props}
      size="xs"
      variant="outline"
      className="max-w-full border-primary/30 bg-primary/5 text-primary hover:bg-primary/10 hover:text-primary dark:bg-primary/5 dark:hover:bg-primary/10"
    >
      <HugeiconsIcon
        icon={Cancel01Icon}
        className="size-3"
        aria-hidden="true"
      />
      <span className="truncate">{children}</span>
    </Button>
  );
}

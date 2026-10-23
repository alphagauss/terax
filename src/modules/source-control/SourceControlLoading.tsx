import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/** 侧栏变更与提交图共用的加载提示，隐藏时停止图标动画。 */
export function SourceControlLoading({
  label,
  active,
}: {
  label: string;
  active: boolean;
}) {
  return (
    <div
      role="status"
      className="flex h-full min-h-0 flex-1 items-center justify-center gap-2 px-4 text-center text-[11px] text-muted-foreground"
    >
      <Spinner
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 motion-reduce:animate-none",
          !active && "animate-none",
        )}
      />
      <span>{label}</span>
    </div>
  );
}

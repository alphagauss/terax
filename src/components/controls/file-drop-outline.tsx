/** 文件拖放使用统一的内侧细边框，不遮盖内容或改变接收区尺寸。 */
import { cn } from "@/lib/utils";

export const FILE_DROP_TARGET_CLASS = "ring-1 ring-inset ring-primary/60";

export function FileDropOutline() {
  return (
    <div
      aria-hidden="true"
      data-slot="file-drop-outline"
      className={cn(
        "pointer-events-none absolute inset-0 z-30 rounded-[inherit]",
        FILE_DROP_TARGET_CLASS,
      )}
    />
  );
}

/** 只读展示活动文件路径或终端 cwd，复制始终使用完整路径，不参与目录跟随。 */
import { Hint } from "@/components/controls/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/menu/context-menu";
import { writeClipboardText } from "@/lib/clipboard";
import { useTranslation } from "react-i18next";
import { reportError } from "@/lib/errors";

export function ActivePath({
  path,
  file = false,
}: {
  path: string | null;
  file?: boolean;
}) {
  const { t } = useTranslation("statusbar");
  if (!path) return null;
  const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Hint content={path}>
          <span
            className="min-w-0 truncate text-left text-muted-foreground cursor-default"
            dir="rtl"
          >
            <bdi dir="ltr">
              {file ? (
                <>
                  {path.slice(0, split)}
                  <span className="text-foreground">{path.slice(split)}</span>
                </>
              ) : (
                path
              )}
            </bdi>
          </span>
        </Hint>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => {
            void writeClipboardText(path).catch((cause) =>
              reportError(t("common:pageMenu.copyFailed"), { error: cause }),
            );
          }}
        >
          {t("path.copyFullPath")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

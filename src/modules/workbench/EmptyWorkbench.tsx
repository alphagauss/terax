/**
 * 本文件实现零标签 Space 的基础启动页。
 * 页面只复用现有新建标签动作，不保存状态，也不作为 Workbench 标签存在。
 */

import { pathBasename } from "@/lib/utils";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import { DEFAULT_SPACE_ID } from "@/modules/workbench/types";
import { Button } from "@/components/controls/button";
import {
  ComputerTerminal02Icon,
  Globe02Icon,
  IncognitoIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslation } from "react-i18next";

type Props = {
  onNewTerminal: () => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewEditor: () => void;
  onNewWebPreview: () => void;
};

/**
 * Workbench 基础启动页。
 *
 * Space 没有标签时提供与标签栏新建菜单一致的入口，点击后由上层创建真实标签。
 */
export function EmptyWorkbench({
  onNewTerminal,
  onNewBlock,
  onNewPrivate,
  onNewEditor,
  onNewWebPreview,
}: Props) {
  const { t } = useTranslation("tabs");
  const spaceRoot = useSpaces((state) =>
    state.activeId !== DEFAULT_SPACE_ID
      ? state.spaces.find((space) => space.id === state.activeId)?.root
      : null,
  );
  const actions = [
    [t("terminal"), ComputerTerminal02Icon, onNewTerminal],
    [t("blocks"), ComputerTerminal02Icon, onNewBlock],
    [t("privacy"), IncognitoIcon, onNewPrivate],
    [t("editor"), PencilEdit02Icon, onNewEditor],
    [t("webPreview"), Globe02Icon, onNewWebPreview],
  ] as const;

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background px-8 py-12">
      <section className="w-full max-w-md">
        <h1 className="mb-4 break-words text-lg font-medium text-foreground">
          {spaceRoot
            ? t("startFromDirectory", { name: pathBasename(spaceRoot) })
            : t("start")}
        </h1>
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {actions.map(([label, icon, action]) => (
            <Button
              size="lg"
              key={label}
              variant="ghost"
              className="justify-start px-2.5 text-primary hover:text-primary"
              onClick={action}
            >
              <HugeiconsIcon icon={icon} size={16} strokeWidth={1.75} />
              {label}
            </Button>
          ))}
        </div>
      </section>
    </div>
  );
}

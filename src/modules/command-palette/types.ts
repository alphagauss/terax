/**
 * 本文件定义命令面板条目和模式的公共类型。
 * 命令面板只保留命令、历史与帮助模式，工作区内容搜索由独立侧边栏持有。
 */

import type { ShortcutId } from "@/modules/shortcuts";
import type { TerminalIcon } from "@hugeicons/core-free-icons";

export type PaletteIcon = typeof TerminalIcon;

export type PaletteItem = {
  id: string;
  title: string;
  group: string;
  keywords?: string[];
  icon?: PaletteIcon;
  iconUrl?: string;
  shortcutId?: ShortcutId;
  trailing?: string;
  disabledReason?: string;
  run: () => void;
};

export type PaletteMode = "commands" | "history" | "help";

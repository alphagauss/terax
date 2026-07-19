import i18n from "@/i18n";
import type { Tab } from "@/modules/workbench";
import {
  Cancel01Icon,
  DashboardSquare01Icon,
  FileEditIcon,
  FileSearchIcon,
  Globe02Icon,
  IncognitoIcon,
  KeyboardIcon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  PaintBoardIcon,
  Search01Icon,
  Settings01Icon,
  SidebarLeftIcon,
  SourceCodeIcon,
  SparklesIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import type { PaletteItem } from "./types";

const t = (key: string, opts?: Record<string, unknown>) =>
  i18n.t(`commandPalette:${key}`, opts ?? {}) as string;

export const COMMAND_GROUPS = [
  "General",
  "Spaces",
  "Tabs",
  "Workbench",
  "Git",
  "Search",
  "View",
  "AI",
] as const;

export type CommandPaletteActionContext = {
  tabs: Tab[];
  activeId: number;
  canFind: boolean;
  explorerRoot: string | null;
  home: string | null;
  openNewWindow: () => void;
  workspaceWindowMode: "single" | "multiple";
  openNewTab: () => void;
  openNewBlock: () => void;
  openNewPrivate: () => void;
  openNewEditor: () => void;
  openNewWebPreview: () => void;
  openGitGraph: () => void;
  toggleSourceControl: () => void;
  closeActiveTab: () => void;
  splitGroupRight: () => void;
  splitGroupDown: () => void;
  focusSearch: () => void;
  focusExplorerSearch: () => void;
  toggleSidebar: () => void;
  toggleAi: () => void;
  askAiSelection: () => void;
  openSettings: () => void;
  openKeyboardShortcuts: () => void;
  spaces: { id: string; name: string }[];
  activeSpaceId: string | null;
  openSpacesOverview: () => void;
  newSpace: () => void;
  switchSpace: (id: string) => void;
};

const noop = () => {};

export function createCommandItems(
  ctx: CommandPaletteActionContext,
): PaletteItem[] {
  const activeTab = ctx.tabs.find((tab) => tab.id === ctx.activeId);
  const onlyOneTab =
    !activeTab ||
    ctx.tabs.filter((tab) => tab.spaceId === activeTab.spaceId).length < 2;
  const noWorkspaceRoot = !ctx.explorerRoot && !ctx.home;
  const splitDisabled =
    !activeTab || activeTab.kind === "ai-diff"
      ? t("disabled.cannotCopyView")
      : undefined;
  const closeDisabled = onlyOneTab ? "Last tab" : undefined;
  const windowItems: PaletteItem[] =
    ctx.workspaceWindowMode === "multiple"
      ? [
          {
            id: "window.new",
            title: "New Window",
            group: "General",
            keywords: ["window", "workspace", "new"],
            icon: DashboardSquare01Icon,
            shortcutId: "window.new",
            run: ctx.openNewWindow,
          },
        ]
      : [];

  return [
    ...windowItems,
    {
      id: "settings.open",
      title: "Open settings",
      group: "General",
      keywords: ["preferences", "config"],
      icon: Settings01Icon,
      shortcutId: "settings.open",
      run: ctx.openSettings,
    },
    {
      id: "theme.pick",
      title: t("cmd.theme.pick"),
      group: "General",
      keywords: ["theme", "appearance", "color", "dark", "light"],
      icon: PaintBoardIcon,
      run: noop,
    },
    {
      id: "shortcuts.open",
      title: t("cmd.shortcuts.open"),
      group: "General",
      keywords: ["keys", "keybindings", "settings"],
      icon: KeyboardIcon,
      run: ctx.openKeyboardShortcuts,
    },
    {
      id: "spaces.overview",
      title: "Spaces: Overview",
      group: "Spaces",
      keywords: [
        "spaces",
        "sessions",
        "overview",
        "organize",
        "manage",
        "move",
      ],
      icon: DashboardSquare01Icon,
      run: ctx.openSpacesOverview,
    },
    {
      id: "spaces.new",
      title: t("cmd.spaces.new"),
      group: "Spaces",
      keywords: ["space", "session", "workspace", "group", "create"],
      icon: DashboardSquare01Icon,
      run: ctx.newSpace,
    },
    ...ctx.spaces.map((sp) => ({
      id: `spaces.switch.${sp.id}`,
      title: `Switch to ${sp.name}`,
      group: "Spaces" as const,
      keywords: ["space", "switch", "session", sp.name],
      icon: DashboardSquare01Icon,
      disabledReason: sp.id === ctx.activeSpaceId ? "Current space" : undefined,
      run: () => ctx.switchSpace(sp.id),
    })),
    {
      id: "tab.new",
      title: "New terminal",
      group: "Tabs",
      keywords: ["shell", "terminal", "new tab"],
      icon: TerminalIcon,
      shortcutId: "tab.new",
      run: ctx.openNewTab,
    },
    {
      id: "tab.newBlock",
      title: t("cmd.tab.newBlock"),
      group: "Tabs",
      keywords: ["blocks", "warp", "command blocks", "terminal"],
      icon: DashboardSquare01Icon,
      run: ctx.openNewBlock,
    },
    {
      id: "tab.newPrivate",
      title: t("cmd.tab.newPrivate"),
      group: "Tabs",
      keywords: ["privacy", "private", "incognito", "hidden from ai"],
      icon: IncognitoIcon,
      shortcutId: "tab.newPrivate",
      run: ctx.openNewPrivate,
    },
    {
      id: "tab.newEditor",
      title: t("cmd.tab.newEditor"),
      group: "Tabs",
      keywords: ["file", "editor", "create"],
      icon: FileEditIcon,
      shortcutId: "tab.newEditor",
      disabledReason: noWorkspaceRoot
        ? t("disabled.noWorkspaceRoot")
        : undefined,
      run: ctx.openNewEditor,
    },
    {
      id: "tab.newWebPreview",
      title: t("cmd.tab.newWebPreview"),
      group: "Tabs",
      keywords: ["browser", "web", "localhost", "preview"],
      icon: Globe02Icon,
      shortcutId: "tab.newWebPreview",
      run: ctx.openNewWebPreview,
    },
    {
      id: "tab.close",
      title: t("cmd.tab.close"),
      group: "Tabs",
      keywords: ["close", "remove", "pane"],
      icon: Cancel01Icon,
      shortcutId: "tab.close",
      disabledReason: closeDisabled,
      run: ctx.closeActiveTab,
    },
    {
      id: "workbench.splitRight",
      title: t("cmd.workbench.splitRight"),
      group: "Workbench",
      keywords: ["terminal", "pane", "split", "right", "column"],
      icon: LayoutTwoColumnIcon,
      shortcutId: "workbench.splitRight",
      disabledReason: splitDisabled,
      run: ctx.splitGroupRight,
    },
    {
      id: "workbench.splitDown",
      title: t("cmd.workbench.splitDown"),
      group: "Workbench",
      keywords: ["terminal", "pane", "split", "down", "row"],
      icon: LayoutTwoRowIcon,
      shortcutId: "workbench.splitDown",
      disabledReason: splitDisabled,
      run: ctx.splitGroupDown,
    },
    {
      id: "git.graph",
      title: t("cmd.git.graph"),
      group: "Git",
      keywords: ["git", "graph", "history", "log", "commits"],
      icon: SourceCodeIcon,
      run: ctx.openGitGraph,
    },
    {
      id: "git.source",
      title: t("cmd.git.source"),
      group: "Git",
      keywords: ["git", "source control", "changes", "staging", "diff"],
      icon: SourceCodeIcon,
      shortcutId: "view.sourceControl",
      run: ctx.toggleSourceControl,
    },
    {
      id: "search.content",
      title: t("cmd.search.content"),
      group: "Search",
      keywords: ["grep", "ripgrep", "text", "contents", "search in files"],
      icon: FileSearchIcon,
      trailing: "#",
      run: noop,
    },
    {
      id: "history.open",
      title: t("cmd.history.open"),
      group: "Search",
      keywords: ["history", "shell", "rerun", "previous commands"],
      icon: TerminalIcon,
      trailing: ">",
      run: noop,
    },
    {
      id: "search.focus",
      title: t("cmd.search.focus"),
      group: "Search",
      keywords: ["find", "terminal", "editor", "current"],
      icon: Search01Icon,
      shortcutId: "search.focus",
      disabledReason: ctx.canFind ? undefined : t("disabled.noSearchableView"),
      run: ctx.focusSearch,
    },
    {
      id: "explorer.search",
      title: t("cmd.explorer.search"),
      group: "Search",
      keywords: ["explorer", "workspace", "file", "open"],
      icon: Search01Icon,
      shortcutId: "explorer.search",
      disabledReason: ctx.explorerRoot
        ? undefined
        : t("disabled.noWorkspaceRoot"),
      run: ctx.focusExplorerSearch,
    },
    {
      id: "sidebar.toggle",
      title: t("cmd.sidebar.toggle"),
      group: "View",
      keywords: ["sidebar", "files", "explorer"],
      icon: SidebarLeftIcon,
      shortcutId: "sidebar.toggle",
      run: ctx.toggleSidebar,
    },
    {
      id: "ai.toggle",
      title: t("cmd.ai.toggle"),
      group: "AI",
      keywords: ["assistant", "chat", "agent"],
      icon: SparklesIcon,
      shortcutId: "ai.toggle",
      run: ctx.toggleAi,
    },
    {
      id: "ai.askSelection",
      title: t("cmd.ai.askSelection"),
      group: "AI",
      keywords: ["selection", "explain", "assistant", "chat"],
      icon: SparklesIcon,
      shortcutId: "ai.askSelection",
      run: ctx.askAiSelection,
    },
  ];
}

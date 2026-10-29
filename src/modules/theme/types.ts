/**
 * 本文件定义应用、终端和编辑器调色板及主题变体的数据结构。
 * 颜色字段均为可选项，未声明的字段由全局主题变量提供回退值。
 */

export type ThemeMode = "light" | "dark";

export type ThemeColors = Partial<{
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  success: string;
  warning: string;
  info: string;
  border: string;
  layoutDivider: string;
  input: string;
  ring: string;
  interactiveHover: string;
  interactiveActive: string;
  searchMatchBackground: string;
  searchCurrentMatchBackground: string;
  gitModified: string;
  gitAdded: string;
  gitUntracked: string;
  gitRenamed: string;
  gitDeleted: string;
  editorGitModified: string;
  editorGitAdded: string;
  editorGitDeleted: string;
  chart1: string;
  chart2: string;
  chart3: string;
  chart4: string;
  chart5: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarPrimary: string;
  sidebarPrimaryForeground: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  activityBarHover: string;
  activityBarActive: string;
  activityBarSelected: string;
  activityBarSelectedHover: string;
  activityBarSelectedActive: string;
  activityBarSelectedForeground: string;
  sidebarBorder: string;
  sidebarRing: string;
  scrollbarThumb: string;
  scrollbarThumbHover: string;
  scrollbarTrack: string;
  radius: string;
}>;

export type TerminalPalette = Partial<{
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selection: string;
  ansi: readonly [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
}>;

/** CodeMirror 编辑器表面与语法高亮调色板。 */
export type EditorPalette = {
  background: string;
  foreground: string;
  caret: string;
  selection: string;
  lineHighlight: string;
  gutterForeground: string;
  comment: string;
  commentItalic?: boolean;
  keyword: string;
  boldKeyword?: boolean;
  string: string;
  number: string;
  constant?: string;
  function: string;
  variable: string;
  property: string;
  type: string;
  operator: string;
  tag: string;
  tagBracket?: string;
  attribute: string;
  attributeValue?: string;
  heading: string;
  link: string;
  invalid: string;
};

export type ThemeVariant = {
  colors?: ThemeColors;
  terminal?: TerminalPalette;
  editor: EditorPalette;
};

/** 默认基准主题必须显式提供的完整 UI 配色。 */
export type CompleteThemeColors = Required<ThemeColors>;

/** 默认基准主题必须显式提供的完整终端调色板。 */
export type CompleteTerminalPalette = Required<TerminalPalette>;

/** 用于默认基准与参考模板的完整主题变体。 */
export type CompleteThemeVariant = {
  colors: CompleteThemeColors;
  terminal: CompleteTerminalPalette;
  editor: EditorPalette;
};

export type Theme = {
  id: string;
  name: string;
  author?: string;
  description?: string;
  variants: {
    light?: ThemeVariant;
    dark?: ThemeVariant;
  };
};

export const DEFAULT_THEME_ID = "modern";

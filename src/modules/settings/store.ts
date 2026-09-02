/**
 * 本文件定义应用偏好设置、默认值及共享设置存取逻辑。
 * 负责将持久化设置归一化为前端可用状态，不覆盖用户已保存的偏好。
 */

import {
  mutateSharedStore,
  onSharedStoreChange,
  readSharedStore,
  setSharedStoreKey,
} from "@/lib/sharedStore";
import {
  builtinProviderId,
  DEFAULT_AUTOCOMPLETE_MODEL_REF,
  DEFAULT_MODEL_REF,
  DEFAULT_STT_PROVIDER,
  isConfigurableProvider,
  isModelRef,
  isModelRefAvailable,
  isProviderInstance,
  LMSTUDIO_DEFAULT_BASE_URL,
  MLX_DEFAULT_BASE_URL,
  type ModelRef,
  OLLAMA_DEFAULT_BASE_URL,
  type ProviderInstance,
  providerFromBuiltinId,
  type SttProvider,
  WHISPERCPP_DEFAULT_BASE_URL,
} from "@/modules/ai/config";
import type { KeyBinding, ShortcutId } from "@/modules/shortcuts/shortcuts";
import { DEFAULT_THEME_ID } from "@/modules/theme/types";
import type { UnlistenFn } from "@tauri-apps/api/event";

export type ThemePref = "system" | "light" | "dark";

export type DiffViewMode = "inline" | "split";

export type BackgroundKind = "none" | "image";

export type WorkspaceWindowMode = "single" | "multiple";

export type TerminalCursorStyle = "bar" | "block" | "underline";

export const EDITOR_THEMES = [
  "modern",
  "kanagawa",
  "kanagawa-lotus",
  "kanagawa-dragon",
  "tokyo-night",
  "catppuccin-mocha",
  "catppuccin-latte",
  "rose-pine",
  "rose-pine-dawn",
  "everforest",
  "everforest-light",
  "dracula",
  "solarized-dark",
  "solarized-light",
  "nord",
  "gruvbox-dark",
  "atomone",
  "aura",
  "copilot",
  "github-dark",
  "github-light",
  "xcode-dark",
  "xcode-light",
] as const;

export type EditorThemeId = (typeof EDITOR_THEMES)[number];

/** "auto" 实时跟随当前应用主题内嵌的编辑器调色板。 */
export const EDITOR_THEME_AUTO = "auto" as const;
export type EditorThemePref = typeof EDITOR_THEME_AUTO | EditorThemeId;

export function isEditorThemeId(v: unknown): v is EditorThemeId {
  return (
    typeof v === "string" && (EDITOR_THEMES as readonly string[]).includes(v)
  );
}

export const EDITOR_THEME_MODE: Record<
  EditorThemeId,
  "light" | "dark" | "both"
> = {
  modern: "both",
  kanagawa: "dark",
  "kanagawa-lotus": "light",
  "kanagawa-dragon": "dark",
  "tokyo-night": "dark",
  "catppuccin-mocha": "dark",
  "catppuccin-latte": "light",
  "rose-pine": "dark",
  "rose-pine-dawn": "light",
  everforest: "dark",
  "everforest-light": "light",
  dracula: "dark",
  "solarized-dark": "dark",
  "solarized-light": "light",
  nord: "dark",
  "gruvbox-dark": "dark",
  atomone: "dark",
  aura: "dark",
  copilot: "dark",
  "github-dark": "dark",
  "github-light": "light",
  "xcode-dark": "dark",
  "xcode-light": "light",
};

export const EDITOR_THEME_LABELS: Record<EditorThemeId, string> = {
  modern: "Modern",
  kanagawa: "Kanagawa Wave",
  "kanagawa-lotus": "Kanagawa Lotus",
  "kanagawa-dragon": "Kanagawa Dragon",
  "tokyo-night": "Tokyo Night",
  "catppuccin-mocha": "Catppuccin Mocha",
  "catppuccin-latte": "Catppuccin Latte",
  "rose-pine": "Rosé Pine",
  "rose-pine-dawn": "Rosé Pine Dawn",
  everforest: "Everforest Dark",
  "everforest-light": "Everforest Light",
  dracula: "Dracula",
  "solarized-dark": "Solarized Dark",
  "solarized-light": "Solarized Light",
  nord: "Nord",
  "gruvbox-dark": "Gruvbox Dark",
  atomone: "Atom One",
  aura: "Aura",
  copilot: "Copilot",
  "github-dark": "GitHub Dark",
  "github-light": "GitHub Light",
  "xcode-dark": "Xcode Dark",
  "xcode-light": "Xcode Light",
};

/** UI language. Extend this union (and the locale resources) to add languages. */
export type Language = "en" | "zh-CN";

export type Preferences = {
  theme: ThemePref;
  themeId: string;
  language: Language;
  backgroundKind: BackgroundKind;
  backgroundImageId: string | null;
  backgroundOpacity: number;
  backgroundBlur: number;
  defaultModel: ModelRef;
  defaultSubagentModel: ModelRef | null;
  maxConcurrentSubagents: number;
  editorTheme: EditorThemePref;
  editorFontSize: number;
  customInstructions: string;
  autostart: boolean;
  restoreWindowState: boolean;
  workspaceWindowMode: WorkspaceWindowMode;
  autocompleteEnabled: boolean;
  autocompleteTrigger: AutocompleteTrigger;
  autocompleteModel: ModelRef;
  providerModels: Record<string, string>;
  lmstudioBaseURL: string;
  mlxBaseURL: string;
  ollamaBaseURL: string;
  customProviders: ProviderInstance[];
  sttProvider: SttProvider;
  groqSttModel: string;
  whispercppBaseURL: string;
  favoriteModels: ModelRef[];
  recentModels: ModelRef[];
  vimMode: boolean;
  editorWordWrap: boolean;
  diffViewMode: DiffViewMode;
  showHidden: boolean;
  explorerGitDecorations: boolean;
  sourceControlShowUndoCommit: boolean;
  terminalWebglEnabled: boolean;
  terminalCursorBlink: boolean;
  terminalCursorStyle: TerminalCursorStyle;
  terminalSmartCopyPaste: boolean;
  terminalFontFamily: string;
  terminalFontWeight: string;
  terminalShell: string;
  terminalLetterSpacing: number;
  terminalFontSize: number;
  terminalScrollback: number;
  zoomLevel: number;
  agentNotifications: boolean;
  shortcuts: Record<ShortcutId, KeyBinding[]>;
  editorAutoSave: boolean;
  editorAutoSaveDelay: number;
  editorFormatOnSave: boolean;
  editorFormatter: EditorFormatter;
  /** languageResolver id -> formatter, overriding the global default. */
  editorFormatterByLang: Record<string, EditorFormatter>;
  /** Shell template for the "custom" formatter; {file} is the quoted path. */
  editorCustomFormatCommand: string;
  lspActivation: Record<string, LspActivation>;
  lspCustomServers: LspCustomServer[];
};

export type EditorFormatter =
  | "lsp"
  | "biome"
  | "prettier"
  | "ruff"
  | "rustfmt"
  | "gofmt"
  | "clang-format"
  | "shfmt"
  | "zigfmt"
  | "custom";

export type LspActivation = "enabled" | "dismissed";

export type LspCustomServer = {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** languageResolver id -> LSP languageId */
  languages: Record<string, string>;
  rootMarkers: string[];
};

const KEY_THEME = "theme";
const KEY_THEME_ID = "themeId";
const KEY_LANGUAGE = "language";
const KEY_BG_KIND = "backgroundKind";
const KEY_BG_IMAGE_ID = "backgroundImageId";
const KEY_BG_OPACITY = "backgroundOpacity";
const KEY_BG_BLUR = "backgroundBlur";
const KEY_DEFAULT_MODEL = "defaultModel";
const KEY_DEFAULT_SUBAGENT_MODEL = "defaultSubagentModel";
const KEY_MAX_CONCURRENT_SUBAGENTS = "maxConcurrentSubagents";
const KEY_EDITOR_THEME = "editorTheme";
const KEY_EDITOR_FONT_SIZE = "editorFontSize";
const KEY_CUSTOM_INSTRUCTIONS = "customInstructions";
const KEY_AUTOSTART = "autostart";
const KEY_RESTORE_WINDOW = "restoreWindowState";
const KEY_WORKSPACE_WINDOW_MODE = "workspaceWindowMode";
export type AutocompleteTrigger = "auto" | "manual";

const KEY_AUTOCOMPLETE_ENABLED = "autocompleteEnabled";
const KEY_AUTOCOMPLETE_TRIGGER = "autocompleteTrigger";
const KEY_AUTOCOMPLETE_MODEL = "autocompleteModel";
const KEY_PROVIDER_MODELS = "providerModels";
const KEY_LMSTUDIO_BASE_URL = "lmstudioBaseURL";
const KEY_MLX_BASE_URL = "mlxBaseURL";
const KEY_OLLAMA_BASE_URL = "ollamaBaseURL";
const KEY_CUSTOM_PROVIDERS = "customProviders";
const KEY_STT_PROVIDER = "sttProvider";
const KEY_GROQ_STT_MODEL = "groqSttModel";
const KEY_WHISPERCPP_BASE_URL = "whispercppBaseURL";
const KEY_FAVORITE_MODELS = "favoriteModels";
const KEY_RECENT_MODELS = "recentModels";
const KEY_VIM_MODE = "vimMode";
const KEY_EDITOR_WORD_WRAP = "editorWordWrap";
const KEY_DIFF_VIEW_MODE = "diffViewMode";
const KEY_SHOW_HIDDEN = "showHidden";
const KEY_EXPLORER_GIT_DECORATIONS = "explorerGitDecorations";
const KEY_SOURCE_CONTROL_SHOW_UNDO_COMMIT = "sourceControlShowUndoCommit";
const KEY_TERMINAL_WEBGL_ENABLED = "terminalWebglEnabled";
const KEY_TERMINAL_CURSOR_BLINK = "terminalCursorBlink";
const KEY_TERMINAL_CURSOR_STYLE = "terminalCursorStyle";
const KEY_TERMINAL_SMART_COPY_PASTE = "terminalSmartCopyPaste";
const KEY_TERMINAL_FONT_FAMILY = "terminalFontFamily";
const KEY_TERMINAL_FONT_WEIGHT = "terminalFontWeight";
const KEY_TERMINAL_SHELL = "terminalShell";
const KEY_TERMINAL_LETTER_SPACING = "terminalLetterSpacing";
const KEY_TERMINAL_FONT_SIZE = "terminalFontSize";
const KEY_TERMINAL_SCROLLBACK = "terminalScrollback";
const KEY_ZOOM_LEVEL = "zoomLevel";
const KEY_AGENT_NOTIFICATIONS = "agentNotifications";
const KEY_SHORTCUTS = "shortcuts";
const KEY_EDITOR_AUTO_SAVE = "editorAutoSave";
const KEY_EDITOR_AUTO_SAVE_DELAY = "editorAutoSaveDelay";
const KEY_EDITOR_FORMAT_ON_SAVE = "editorFormatOnSave";
const KEY_EDITOR_FORMATTER = "editorFormatter";
const KEY_EDITOR_FORMATTER_BY_LANG = "editorFormatterByLang";
const KEY_EDITOR_CUSTOM_FORMAT_COMMAND = "editorCustomFormatCommand";
const KEY_LSP_ACTIVATION = "lspActivation";
const KEY_LSP_CUSTOM_SERVERS = "lspCustomServers";

export const TERMINAL_FONT_SIZE_DEFAULT = 14;
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;

export const TERMINAL_FONT_SIZES = [
  10, 12, 13, 14, 15, 16, 18, 20, 22, 24,
] as const;

export const EDITOR_FONT_SIZE_DEFAULT = 13;
export const EDITOR_FONT_SIZE_MIN = 8;
export const EDITOR_FONT_SIZE_MAX = 32;
export const EDITOR_FONT_SIZES = [
  10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24,
] as const;

export const TERMINAL_SCROLLBACK_DEFAULT = 2000;
export const TERMINAL_SCROLLBACK_MIN = 200;
export const TERMINAL_SCROLLBACK_MAX = 50_000;
export const TERMINAL_SCROLLBACK_PRESETS = [
  500, 1000, 2000, 5000, 10_000, 25_000,
] as const;

export const MAX_CONCURRENT_SUBAGENTS_DEFAULT = 3;
export const MAX_CONCURRENT_SUBAGENTS_MIN = 1;
export const MAX_CONCURRENT_SUBAGENTS_MAX = 8;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "dark",
  themeId: DEFAULT_THEME_ID,
  language: "zh-CN",
  backgroundKind: "none",
  backgroundImageId: null,
  backgroundOpacity: 0.5,
  backgroundBlur: 0,
  defaultModel: DEFAULT_MODEL_REF,
  defaultSubagentModel: null,
  maxConcurrentSubagents: MAX_CONCURRENT_SUBAGENTS_DEFAULT,
  editorTheme: EDITOR_THEME_AUTO,
  editorFontSize: EDITOR_FONT_SIZE_DEFAULT,
  customInstructions: "",
  autostart: false,
  restoreWindowState: true,
  workspaceWindowMode: "single",
  autocompleteEnabled: false,
  autocompleteTrigger: "auto",
  autocompleteModel: DEFAULT_AUTOCOMPLETE_MODEL_REF,
  providerModels: {},
  lmstudioBaseURL: LMSTUDIO_DEFAULT_BASE_URL,
  mlxBaseURL: MLX_DEFAULT_BASE_URL,
  ollamaBaseURL: OLLAMA_DEFAULT_BASE_URL,
  customProviders: [],
  sttProvider: DEFAULT_STT_PROVIDER,
  groqSttModel: "whisper-large-v3-turbo",
  whispercppBaseURL: WHISPERCPP_DEFAULT_BASE_URL,
  favoriteModels: [],
  recentModels: [],
  vimMode: false,
  editorWordWrap: false,
  diffViewMode: "split",
  showHidden: false,
  explorerGitDecorations: true,
  sourceControlShowUndoCommit: true,
  terminalWebglEnabled: true,
  terminalCursorBlink: false,
  terminalCursorStyle: "block",
  terminalSmartCopyPaste: true,
  terminalFontFamily: "",
  terminalFontWeight: "normal",
  terminalShell: "",
  terminalLetterSpacing: 0,
  terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
  terminalScrollback: TERMINAL_SCROLLBACK_DEFAULT,
  zoomLevel: 1.0,
  agentNotifications: true,
  shortcuts: {} as Record<ShortcutId, KeyBinding[]>,
  editorAutoSave: true,
  editorAutoSaveDelay: 500,
  editorFormatOnSave: false,
  editorFormatter: "lsp",
  editorFormatterByLang: {},
  editorCustomFormatCommand: "",
  lspActivation: {},
  lspCustomServers: [],
};

async function writePref<T>(key: string, value: T): Promise<void> {
  await setSharedStoreKey("settings", key, value);
}

export type ModelSettingsPatch = Partial<
  Pick<
    Preferences,
    | "defaultModel"
    | "defaultSubagentModel"
    | "autocompleteModel"
    | "providerModels"
    | "lmstudioBaseURL"
    | "mlxBaseURL"
    | "ollamaBaseURL"
    | "customProviders"
    | "favoriteModels"
    | "recentModels"
  >
>;

const MODEL_SETTING_KEYS: Record<keyof ModelSettingsPatch, string> = {
  defaultModel: KEY_DEFAULT_MODEL,
  defaultSubagentModel: KEY_DEFAULT_SUBAGENT_MODEL,
  autocompleteModel: KEY_AUTOCOMPLETE_MODEL,
  providerModels: KEY_PROVIDER_MODELS,
  lmstudioBaseURL: KEY_LMSTUDIO_BASE_URL,
  mlxBaseURL: KEY_MLX_BASE_URL,
  ollamaBaseURL: KEY_OLLAMA_BASE_URL,
  customProviders: KEY_CUSTOM_PROVIDERS,
  favoriteModels: KEY_FAVORITE_MODELS,
  recentModels: KEY_RECENT_MODELS,
};

/** 在一次共享存储事务中保存相互依赖的模型配置和引用。 */
export async function setModelSettings(
  patch: ModelSettingsPatch,
): Promise<void> {
  const entries = Object.entries(patch).filter(
    (
      entry,
    ): entry is [
      keyof ModelSettingsPatch,
      Exclude<(typeof entry)[1], undefined>,
    ] => entry[1] !== undefined,
  );
  if (entries.length === 0) return;
  await mutateSharedStore(
    "settings",
    entries.map(([key, value]) => ({
      kind: "set" as const,
      key: MODEL_SETTING_KEYS[key],
      value,
    })),
  );
}

/** 判断模型引用是否仍属于当前保存的 Provider 配置。 */
function isAvailableModelRef(
  value: unknown,
  providers: readonly ProviderInstance[],
  providerModels: Readonly<Record<string, string | undefined>>,
): value is ModelRef {
  return (
    isModelRef(value) && isModelRefAvailable(value, providers, providerModels)
  );
}

export async function loadPreferences(): Promise<Preferences> {
  // Single IPC roundtrip — fetching keys individually fans out to one
  // `plugin:store|get` per setting and is the dominant boot cost.
  const values = await readSharedStore("settings");
  const get = <T>(k: string): T | undefined => values[k] as T | undefined;
  const storedProviders = get<unknown>(KEY_CUSTOM_PROVIDERS);
  const seenProviderIds = new Set<string>();
  const customProviders = Array.isArray(storedProviders)
    ? storedProviders.filter((value): value is ProviderInstance => {
        if (!isProviderInstance(value) || seenProviderIds.has(value.id)) {
          return false;
        }
        seenProviderIds.add(value.id);
        return true;
      })
    : [];
  const customProviderIds = new Set(
    customProviders.map((provider) => provider.id),
  );
  const storedProviderModels = get<unknown>(KEY_PROVIDER_MODELS);
  const providerModels =
    storedProviderModels && typeof storedProviderModels === "object"
      ? Object.fromEntries(
          Object.entries(storedProviderModels).filter(
            ([providerId, modelId]) => {
              const builtin = providerFromBuiltinId(providerId);
              return (
                typeof modelId === "string" &&
                (customProviderIds.has(providerId) ||
                  (builtin !== null && isConfigurableProvider(builtin)))
              );
            },
          ),
        )
      : {};
  const lmstudioBaseURL =
    get<string>(KEY_LMSTUDIO_BASE_URL) ?? DEFAULT_PREFERENCES.lmstudioBaseURL;
  const mlxBaseURL =
    get<string>(KEY_MLX_BASE_URL) ?? DEFAULT_PREFERENCES.mlxBaseURL;
  const ollamaBaseURL =
    get<string>(KEY_OLLAMA_BASE_URL) ?? DEFAULT_PREFERENCES.ollamaBaseURL;
  const availableProviderModels = { ...providerModels };
  if (!lmstudioBaseURL.trim()) {
    delete availableProviderModels[builtinProviderId("lmstudio")];
  }
  if (!mlxBaseURL.trim()) {
    delete availableProviderModels[builtinProviderId("mlx")];
  }
  if (!ollamaBaseURL.trim()) {
    delete availableProviderModels[builtinProviderId("ollama")];
  }
  const storedFavoriteModels = get<unknown>(KEY_FAVORITE_MODELS);
  const favoriteModels = Array.isArray(storedFavoriteModels)
    ? storedFavoriteModels
    : DEFAULT_PREFERENCES.favoriteModels;
  const storedRecentModels = get<unknown>(KEY_RECENT_MODELS);
  const recentModels = Array.isArray(storedRecentModels)
    ? storedRecentModels
    : DEFAULT_PREFERENCES.recentModels;
  const readModelRef = (key: string): ModelRef | null => {
    const stored = get<unknown>(key);
    return isAvailableModelRef(stored, customProviders, availableProviderModels)
      ? stored
      : null;
  };
  return {
    theme: get<ThemePref>(KEY_THEME) ?? DEFAULT_PREFERENCES.theme,
    themeId: get<string>(KEY_THEME_ID) ?? DEFAULT_PREFERENCES.themeId,
    language: get<Language>(KEY_LANGUAGE) ?? DEFAULT_PREFERENCES.language,
    backgroundKind:
      get<BackgroundKind>(KEY_BG_KIND) ?? DEFAULT_PREFERENCES.backgroundKind,
    backgroundImageId:
      get<string | null>(KEY_BG_IMAGE_ID) ??
      DEFAULT_PREFERENCES.backgroundImageId,
    backgroundOpacity: clampBgOpacity(
      get<number>(KEY_BG_OPACITY) ?? DEFAULT_PREFERENCES.backgroundOpacity,
    ),
    backgroundBlur: clampBlur(
      get<number>(KEY_BG_BLUR) ?? DEFAULT_PREFERENCES.backgroundBlur,
    ),
    defaultModel:
      readModelRef(KEY_DEFAULT_MODEL) ?? DEFAULT_PREFERENCES.defaultModel,
    defaultSubagentModel: readModelRef(KEY_DEFAULT_SUBAGENT_MODEL),
    maxConcurrentSubagents: clampMaxConcurrentSubagents(
      get<number>(KEY_MAX_CONCURRENT_SUBAGENTS) ??
        DEFAULT_PREFERENCES.maxConcurrentSubagents,
    ),
    editorTheme: ((): EditorThemePref => {
      const stored = get<string>(KEY_EDITOR_THEME);
      if (stored === EDITOR_THEME_AUTO || isEditorThemeId(stored))
        return stored;
      return DEFAULT_PREFERENCES.editorTheme;
    })(),
    editorFontSize: clampEditorFontSize(
      get<number>(KEY_EDITOR_FONT_SIZE) ?? DEFAULT_PREFERENCES.editorFontSize,
    ),
    customInstructions:
      get<string>(KEY_CUSTOM_INSTRUCTIONS) ??
      DEFAULT_PREFERENCES.customInstructions,
    autostart: get<boolean>(KEY_AUTOSTART) ?? DEFAULT_PREFERENCES.autostart,
    restoreWindowState:
      get<boolean>(KEY_RESTORE_WINDOW) ??
      DEFAULT_PREFERENCES.restoreWindowState,
    workspaceWindowMode:
      get<WorkspaceWindowMode>(KEY_WORKSPACE_WINDOW_MODE) === "multiple"
        ? "multiple"
        : DEFAULT_PREFERENCES.workspaceWindowMode,
    autocompleteEnabled:
      get<boolean>(KEY_AUTOCOMPLETE_ENABLED) ??
      DEFAULT_PREFERENCES.autocompleteEnabled,
    autocompleteTrigger:
      get<AutocompleteTrigger>(KEY_AUTOCOMPLETE_TRIGGER) ??
      DEFAULT_PREFERENCES.autocompleteTrigger,
    autocompleteModel:
      readModelRef(KEY_AUTOCOMPLETE_MODEL) ??
      DEFAULT_PREFERENCES.autocompleteModel,
    providerModels,
    lmstudioBaseURL,
    mlxBaseURL,
    ollamaBaseURL,
    customProviders,
    sttProvider:
      get<SttProvider>(KEY_STT_PROVIDER) ?? DEFAULT_PREFERENCES.sttProvider,
    groqSttModel:
      get<string>(KEY_GROQ_STT_MODEL) ?? DEFAULT_PREFERENCES.groqSttModel,
    whispercppBaseURL:
      get<string>(KEY_WHISPERCPP_BASE_URL) ??
      DEFAULT_PREFERENCES.whispercppBaseURL,
    favoriteModels: favoriteModels.filter((value): value is ModelRef =>
      isAvailableModelRef(value, customProviders, availableProviderModels),
    ),
    recentModels: recentModels.filter((value): value is ModelRef =>
      isAvailableModelRef(value, customProviders, availableProviderModels),
    ),
    vimMode: get<boolean>(KEY_VIM_MODE) ?? DEFAULT_PREFERENCES.vimMode,
    editorWordWrap:
      get<boolean>(KEY_EDITOR_WORD_WRAP) ?? DEFAULT_PREFERENCES.editorWordWrap,
    diffViewMode: (() => {
      const stored = get<string>(KEY_DIFF_VIEW_MODE);
      return stored === "inline" || stored === "split"
        ? stored
        : DEFAULT_PREFERENCES.diffViewMode;
    })(),
    showHidden: get<boolean>(KEY_SHOW_HIDDEN) ?? DEFAULT_PREFERENCES.showHidden,
    explorerGitDecorations:
      get<boolean>(KEY_EXPLORER_GIT_DECORATIONS) ??
      DEFAULT_PREFERENCES.explorerGitDecorations,
    sourceControlShowUndoCommit:
      get<boolean>(KEY_SOURCE_CONTROL_SHOW_UNDO_COMMIT) ??
      DEFAULT_PREFERENCES.sourceControlShowUndoCommit,
    terminalWebglEnabled:
      get<boolean>(KEY_TERMINAL_WEBGL_ENABLED) ??
      DEFAULT_PREFERENCES.terminalWebglEnabled,
    terminalCursorBlink:
      get<boolean>(KEY_TERMINAL_CURSOR_BLINK) ??
      DEFAULT_PREFERENCES.terminalCursorBlink,
    terminalCursorStyle: coerceTerminalCursorStyle(
      get<unknown>(KEY_TERMINAL_CURSOR_STYLE),
    ),
    terminalSmartCopyPaste:
      get<boolean>(KEY_TERMINAL_SMART_COPY_PASTE) ??
      DEFAULT_PREFERENCES.terminalSmartCopyPaste,
    terminalFontFamily:
      get<string>(KEY_TERMINAL_FONT_FAMILY) ??
      DEFAULT_PREFERENCES.terminalFontFamily,
    terminalFontWeight: coerceFontWeight(
      get<string>(KEY_TERMINAL_FONT_WEIGHT) ??
        DEFAULT_PREFERENCES.terminalFontWeight,
    ),
    terminalShell:
      get<string>(KEY_TERMINAL_SHELL) ?? DEFAULT_PREFERENCES.terminalShell,
    terminalLetterSpacing:
      get<number>(KEY_TERMINAL_LETTER_SPACING) ??
      DEFAULT_PREFERENCES.terminalLetterSpacing,
    terminalFontSize:
      get<number>(KEY_TERMINAL_FONT_SIZE) ??
      DEFAULT_PREFERENCES.terminalFontSize,
    terminalScrollback: clampScrollback(
      get<number>(KEY_TERMINAL_SCROLLBACK) ??
        DEFAULT_PREFERENCES.terminalScrollback,
    ),
    zoomLevel: get<number>(KEY_ZOOM_LEVEL) ?? DEFAULT_PREFERENCES.zoomLevel,
    agentNotifications:
      get<boolean>(KEY_AGENT_NOTIFICATIONS) ??
      DEFAULT_PREFERENCES.agentNotifications,
    shortcuts:
      get<Record<ShortcutId, KeyBinding[]>>(KEY_SHORTCUTS) ??
      DEFAULT_PREFERENCES.shortcuts,
    editorAutoSave:
      get<boolean>(KEY_EDITOR_AUTO_SAVE) ?? DEFAULT_PREFERENCES.editorAutoSave,
    editorAutoSaveDelay: clampAutoSaveDelay(
      get<number>(KEY_EDITOR_AUTO_SAVE_DELAY) ??
        DEFAULT_PREFERENCES.editorAutoSaveDelay,
    ),
    editorFormatOnSave:
      get<boolean>(KEY_EDITOR_FORMAT_ON_SAVE) ??
      DEFAULT_PREFERENCES.editorFormatOnSave,
    editorFormatter:
      get<EditorFormatter>(KEY_EDITOR_FORMATTER) ??
      DEFAULT_PREFERENCES.editorFormatter,
    editorFormatterByLang:
      get<Record<string, EditorFormatter>>(KEY_EDITOR_FORMATTER_BY_LANG) ??
      DEFAULT_PREFERENCES.editorFormatterByLang,
    editorCustomFormatCommand:
      get<string>(KEY_EDITOR_CUSTOM_FORMAT_COMMAND) ??
      DEFAULT_PREFERENCES.editorCustomFormatCommand,
    lspActivation:
      get<Record<string, LspActivation>>(KEY_LSP_ACTIVATION) ??
      DEFAULT_PREFERENCES.lspActivation,
    lspCustomServers:
      get<LspCustomServer[]>(KEY_LSP_CUSTOM_SERVERS) ??
      DEFAULT_PREFERENCES.lspCustomServers,
  };
}

export async function setLspActivation(
  id: string,
  value: LspActivation | null,
): Promise<void> {
  const current =
    ((await readSharedStore("settings"))[KEY_LSP_ACTIVATION] as Record<
      string,
      LspActivation
    >) ?? {};
  const next = { ...current };
  if (value === null) delete next[id];
  else next[id] = value;
  await writePref(KEY_LSP_ACTIVATION, next);
}

export async function setLspCustomServers(
  value: LspCustomServer[],
): Promise<void> {
  await writePref(KEY_LSP_CUSTOM_SERVERS, value);
}

export async function setTheme(value: ThemePref): Promise<void> {
  await writePref(KEY_THEME, value);
}

export async function setThemeId(value: string): Promise<void> {
  await writePref(KEY_THEME_ID, value);
}

export async function setLanguage(value: Language): Promise<void> {
  await writePref(KEY_LANGUAGE, value);
}

/** Slider stores 0..1. Actual rendered opacity is halved in SurfaceLayer
 *  so the image never exceeds 50% — keeps UI/terminal readable at any setting. */
export const BG_OPACITY_RENDER_FACTOR = 0.5;

function clampBgOpacity(v: number): number {
  if (!Number.isFinite(v)) return 0.7;
  return Math.min(1, Math.max(0, v));
}

function clampBlur(v: number): number {
  if (!Number.isFinite(v)) return 16;
  return Math.min(64, Math.max(0, Math.round(v)));
}

export async function setBackgroundKind(value: BackgroundKind): Promise<void> {
  await writePref(KEY_BG_KIND, value);
}

export async function setBackgroundImageId(
  value: string | null,
): Promise<void> {
  await writePref(KEY_BG_IMAGE_ID, value);
}

export async function setBackgroundOpacity(value: number): Promise<void> {
  await writePref(KEY_BG_OPACITY, clampBgOpacity(value));
}

export async function setBackgroundBlur(value: number): Promise<void> {
  await writePref(KEY_BG_BLUR, clampBlur(value));
}

export async function setDefaultModel(value: ModelRef): Promise<void> {
  await writePref(KEY_DEFAULT_MODEL, value);
}

export async function setDefaultSubagentModel(
  value: ModelRef | null,
): Promise<void> {
  await writePref(KEY_DEFAULT_SUBAGENT_MODEL, value);
}

/** 将每聊天 Subagent 并发数约束到设置界面允许的安全范围。 */
export function clampMaxConcurrentSubagents(value: number): number {
  if (!Number.isFinite(value)) return MAX_CONCURRENT_SUBAGENTS_DEFAULT;
  return Math.min(
    MAX_CONCURRENT_SUBAGENTS_MAX,
    Math.max(MAX_CONCURRENT_SUBAGENTS_MIN, Math.round(value)),
  );
}

export async function setMaxConcurrentSubagents(value: number): Promise<void> {
  await writePref(
    KEY_MAX_CONCURRENT_SUBAGENTS,
    clampMaxConcurrentSubagents(value),
  );
}

export async function setEditorTheme(value: EditorThemePref): Promise<void> {
  await writePref(KEY_EDITOR_THEME, value);
}

export function clampEditorFontSize(value: number): number {
  if (!Number.isFinite(value)) return EDITOR_FONT_SIZE_DEFAULT;
  return Math.min(
    EDITOR_FONT_SIZE_MAX,
    Math.max(EDITOR_FONT_SIZE_MIN, Math.round(value)),
  );
}

export async function setEditorFontSize(value: number): Promise<void> {
  await writePref(KEY_EDITOR_FONT_SIZE, clampEditorFontSize(value));
}

export async function setCustomInstructions(value: string): Promise<void> {
  await writePref(KEY_CUSTOM_INSTRUCTIONS, value);
}

export async function setAutostart(value: boolean): Promise<void> {
  await writePref(KEY_AUTOSTART, value);
}

export async function setRestoreWindowState(value: boolean): Promise<void> {
  await writePref(KEY_RESTORE_WINDOW, value);
}

export async function setWorkspaceWindowMode(
  value: WorkspaceWindowMode,
): Promise<void> {
  await writePref(KEY_WORKSPACE_WINDOW_MODE, value);
}

export async function setAutocompleteTrigger(
  value: AutocompleteTrigger,
): Promise<void> {
  await writePref(KEY_AUTOCOMPLETE_TRIGGER, value);
}

export async function setAutocompleteEnabled(value: boolean): Promise<void> {
  await writePref(KEY_AUTOCOMPLETE_ENABLED, value);
}

export async function setAutocompleteModel(value: ModelRef): Promise<void> {
  await writePref(KEY_AUTOCOMPLETE_MODEL, value);
}

export async function setSttProvider(value: SttProvider): Promise<void> {
  await writePref(KEY_STT_PROVIDER, value);
}

export async function setGroqSttModel(value: string): Promise<void> {
  await writePref(KEY_GROQ_STT_MODEL, value.trim());
}

export async function setWhispercppBaseURL(value: string): Promise<void> {
  await writePref(KEY_WHISPERCPP_BASE_URL, value.trim());
}

export async function setFavoriteModels(value: ModelRef[]): Promise<void> {
  await writePref(KEY_FAVORITE_MODELS, value);
}

export async function setRecentModels(value: ModelRef[]): Promise<void> {
  await writePref(KEY_RECENT_MODELS, value);
}

export async function setVimMode(value: boolean): Promise<void> {
  await writePref(KEY_VIM_MODE, value);
}

export async function setEditorWordWrap(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_WORD_WRAP, value);
}

export async function setDiffViewMode(value: DiffViewMode): Promise<void> {
  await writePref(KEY_DIFF_VIEW_MODE, value);
}

export async function setShowHidden(value: boolean): Promise<void> {
  await writePref(KEY_SHOW_HIDDEN, value);
}

export async function setExplorerGitDecorations(value: boolean): Promise<void> {
  await writePref(KEY_EXPLORER_GIT_DECORATIONS, value);
}

export async function setSourceControlShowUndoCommit(
  value: boolean,
): Promise<void> {
  await writePref(KEY_SOURCE_CONTROL_SHOW_UNDO_COMMIT, value);
}

export async function setTerminalWebglEnabled(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_WEBGL_ENABLED, value);
}

export async function setTerminalCursorBlink(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_CURSOR_BLINK, value);
}

/** 将持久化值限制为 xterm 支持的活动光标样式。 */
export function coerceTerminalCursorStyle(value: unknown): TerminalCursorStyle {
  return value === "bar" || value === "block" || value === "underline"
    ? value
    : DEFAULT_PREFERENCES.terminalCursorStyle;
}

/** 保存终端光标样式，非法输入回退到下游原有的方块样式。 */
export async function setTerminalCursorStyle(value: unknown): Promise<void> {
  await writePref(KEY_TERMINAL_CURSOR_STYLE, coerceTerminalCursorStyle(value));
}

/** 更新终端智能复制粘贴开关。 */
export async function setTerminalSmartCopyPaste(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_SMART_COPY_PASTE, value);
}

export async function setTerminalFontFamily(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_FONT_FAMILY, value.trim());
}

const TERMINAL_FONT_WEIGHT_VALUES = new Set(["normal", "500", "600", "bold"]);

export function coerceFontWeight(value: string): string {
  const v = value.trim();
  return TERMINAL_FONT_WEIGHT_VALUES.has(v) ? v : "normal";
}

export async function setTerminalFontWeight(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_FONT_WEIGHT, coerceFontWeight(value));
}

export async function setTerminalShell(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_SHELL, value.trim());
}

export async function setTerminalLetterSpacing(value: number): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.max(-10, Math.min(10, Math.round(value)))
    : 0;
  await writePref(KEY_TERMINAL_LETTER_SPACING, clamped);
}

export async function setTerminalFontSize(value: number): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.min(
        TERMINAL_FONT_SIZE_MAX,
        Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)),
      )
    : TERMINAL_FONT_SIZE_DEFAULT;
  await writePref(KEY_TERMINAL_FONT_SIZE, clamped);
}

function clampScrollback(value: number): number {
  if (!Number.isFinite(value)) return TERMINAL_SCROLLBACK_DEFAULT;
  return Math.min(
    TERMINAL_SCROLLBACK_MAX,
    Math.max(TERMINAL_SCROLLBACK_MIN, Math.round(value)),
  );
}

export async function setTerminalScrollback(value: number): Promise<void> {
  await writePref(KEY_TERMINAL_SCROLLBACK, clampScrollback(value));
}

export async function setZoomLevel(value: number): Promise<void> {
  await writePref(KEY_ZOOM_LEVEL, value);
}

export const AUTO_SAVE_DELAY_MIN = 100;
export const AUTO_SAVE_DELAY_MAX = 60000;

export function clampAutoSaveDelay(v: number): number {
  if (!Number.isFinite(v)) return 1000;
  return Math.min(
    AUTO_SAVE_DELAY_MAX,
    Math.max(AUTO_SAVE_DELAY_MIN, Math.round(v)),
  );
}

export async function setEditorAutoSave(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_AUTO_SAVE, value);
}

export async function setEditorAutoSaveDelay(value: number): Promise<void> {
  await writePref(KEY_EDITOR_AUTO_SAVE_DELAY, clampAutoSaveDelay(value));
}

export async function setEditorFormatOnSave(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_FORMAT_ON_SAVE, value);
}

export async function setEditorFormatter(
  value: EditorFormatter,
): Promise<void> {
  await writePref(KEY_EDITOR_FORMATTER, value);
}

export async function setEditorFormatterByLang(
  value: Record<string, EditorFormatter>,
): Promise<void> {
  await writePref(KEY_EDITOR_FORMATTER_BY_LANG, value);
}

export async function setEditorCustomFormatCommand(
  value: string,
): Promise<void> {
  await writePref(KEY_EDITOR_CUSTOM_FORMAT_COMMAND, value);
}

export async function setAgentNotifications(value: boolean): Promise<void> {
  await writePref(KEY_AGENT_NOTIFICATIONS, value);
}

export async function setShortcuts(
  value: Record<ShortcutId, KeyBinding[]> | {},
): Promise<void> {
  await writePref(KEY_SHORTCUTS, value);
}

export async function resetShortcuts(): Promise<void> {
  await writePref(KEY_SHORTCUTS, DEFAULT_PREFERENCES.shortcuts);
}

export type PrefKey = keyof Preferences;

/** Subscribe to changes from any window (settings → main). */
export async function onPreferencesChange(
  cb: (key: PrefKey, value: unknown) => void,
): Promise<UnlistenFn> {
  const map: Record<string, PrefKey> = {
    [KEY_THEME]: "theme",
    [KEY_THEME_ID]: "themeId",
    [KEY_LANGUAGE]: "language",
    [KEY_BG_KIND]: "backgroundKind",
    [KEY_BG_IMAGE_ID]: "backgroundImageId",
    [KEY_BG_OPACITY]: "backgroundOpacity",
    [KEY_BG_BLUR]: "backgroundBlur",
    [KEY_DEFAULT_MODEL]: "defaultModel",
    [KEY_DEFAULT_SUBAGENT_MODEL]: "defaultSubagentModel",
    [KEY_MAX_CONCURRENT_SUBAGENTS]: "maxConcurrentSubagents",
    [KEY_EDITOR_THEME]: "editorTheme",
    [KEY_EDITOR_FONT_SIZE]: "editorFontSize",
    [KEY_CUSTOM_INSTRUCTIONS]: "customInstructions",
    [KEY_AUTOSTART]: "autostart",
    [KEY_RESTORE_WINDOW]: "restoreWindowState",
    [KEY_WORKSPACE_WINDOW_MODE]: "workspaceWindowMode",
    [KEY_AUTOCOMPLETE_ENABLED]: "autocompleteEnabled",
    [KEY_AUTOCOMPLETE_TRIGGER]: "autocompleteTrigger",
    [KEY_AUTOCOMPLETE_MODEL]: "autocompleteModel",
    [KEY_PROVIDER_MODELS]: "providerModels",
    [KEY_LMSTUDIO_BASE_URL]: "lmstudioBaseURL",
    [KEY_MLX_BASE_URL]: "mlxBaseURL",
    [KEY_OLLAMA_BASE_URL]: "ollamaBaseURL",
    [KEY_CUSTOM_PROVIDERS]: "customProviders",
    [KEY_STT_PROVIDER]: "sttProvider",
    [KEY_GROQ_STT_MODEL]: "groqSttModel",
    [KEY_WHISPERCPP_BASE_URL]: "whispercppBaseURL",
    [KEY_FAVORITE_MODELS]: "favoriteModels",
    [KEY_RECENT_MODELS]: "recentModels",
    [KEY_VIM_MODE]: "vimMode",
    [KEY_EDITOR_WORD_WRAP]: "editorWordWrap",
    [KEY_DIFF_VIEW_MODE]: "diffViewMode",
    [KEY_SHOW_HIDDEN]: "showHidden",
    [KEY_EXPLORER_GIT_DECORATIONS]: "explorerGitDecorations",
    [KEY_SOURCE_CONTROL_SHOW_UNDO_COMMIT]: "sourceControlShowUndoCommit",
    [KEY_TERMINAL_WEBGL_ENABLED]: "terminalWebglEnabled",
    [KEY_TERMINAL_CURSOR_BLINK]: "terminalCursorBlink",
    [KEY_TERMINAL_CURSOR_STYLE]: "terminalCursorStyle",
    [KEY_TERMINAL_SMART_COPY_PASTE]: "terminalSmartCopyPaste",
    [KEY_TERMINAL_FONT_FAMILY]: "terminalFontFamily",
    [KEY_TERMINAL_FONT_WEIGHT]: "terminalFontWeight",
    [KEY_TERMINAL_SHELL]: "terminalShell",
    [KEY_TERMINAL_LETTER_SPACING]: "terminalLetterSpacing",
    [KEY_TERMINAL_FONT_SIZE]: "terminalFontSize",
    [KEY_TERMINAL_SCROLLBACK]: "terminalScrollback",
    [KEY_ZOOM_LEVEL]: "zoomLevel",
    [KEY_AGENT_NOTIFICATIONS]: "agentNotifications",
    [KEY_SHORTCUTS]: "shortcuts",
    [KEY_EDITOR_AUTO_SAVE]: "editorAutoSave",
    [KEY_EDITOR_AUTO_SAVE_DELAY]: "editorAutoSaveDelay",
    [KEY_EDITOR_FORMAT_ON_SAVE]: "editorFormatOnSave",
    [KEY_EDITOR_FORMATTER]: "editorFormatter",
    [KEY_EDITOR_FORMATTER_BY_LANG]: "editorFormatterByLang",
    [KEY_EDITOR_CUSTOM_FORMAT_COMMAND]: "editorCustomFormatCommand",
    [KEY_LSP_ACTIVATION]: "lspActivation",
    [KEY_LSP_CUSTOM_SERVERS]: "lspCustomServers",
  };
  let previous = await loadPreferences();
  return onSharedStoreChange("settings", async () => {
    const next = await loadPreferences();
    for (const pref of new Set(Object.values(map))) {
      const before = previous[pref];
      const after = next[pref];
      const unchanged =
        Object.is(before, after) ||
        (typeof before === "object" &&
          typeof after === "object" &&
          JSON.stringify(before) === JSON.stringify(after));
      if (!unchanged) cb(pref, after);
    }
    previous = next;
  });
}

export function onKeysChanged(cb: () => void): Promise<UnlistenFn> {
  return onSharedStoreChange("keys-epoch", cb);
}

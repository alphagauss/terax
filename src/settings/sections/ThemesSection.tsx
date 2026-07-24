/**
 * 本文件呈现主题、编辑器配色和背景图片设置。
 * 主题卡片及其操作控件使用项目控制级动效，避免与设置页其他分区出现不同节奏。
 */

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  EDITOR_THEME_AUTO,
  EDITOR_THEME_LABELS,
  EDITOR_THEME_MODE,
  EDITOR_THEMES,
  type EditorThemePref,
  setBackgroundBlur,
  setBackgroundImageId,
  setBackgroundKind,
  setBackgroundOpacity,
  setEditorTheme,
} from "@/modules/settings/store";
import { useTheme } from "@/modules/theme";
import {
  deleteBgImage,
  importBgImageFromFile,
} from "@/modules/theme/bgImageStore";
import {
  deleteCustomTheme,
  saveCustomTheme,
} from "@/modules/theme/customThemes";
import { deleteThemeFile, emitThemeEdit } from "@/modules/theme/themeFiles";
import { listBuiltinThemes } from "@/modules/theme/themes";
import { DEFAULT_THEME_ID } from "@/modules/theme/types";
import { validateTheme } from "@/modules/theme/validateTheme";
import { Edit02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SectionHeader } from "../components/SectionHeader";

/** 主题设置分区。 */
export function ThemesSection() {
  const { t } = useTranslation();
  const { themeId, setThemeId, resolvedMode, customThemes } = useTheme();
  const builtinThemes = listBuiltinThemes();
  const themes = useMemo(
    () => [...builtinThemes, ...customThemes],
    [builtinThemes, customThemes],
  );
  const customIds = useMemo(
    () => new Set(customThemes.map((t) => t.id)),
    [customThemes],
  );

  const [importError, setImportError] = useState<string | null>(null);
  const [bgError, setBgError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bgInputRef = useRef<HTMLInputElement | null>(null);

  const onCreateTheme = () => {
    void emitThemeEdit({ action: "create" });
    void getCurrentWindow().hide();
  };

  const onEditTheme = (id: string) => {
    void emitThemeEdit({ action: "edit", id });
    void getCurrentWindow().hide();
  };

  const editorThemePref = usePreferencesStore((s) => s.editorTheme);
  const backgroundKind = usePreferencesStore((s) => s.backgroundKind);
  const backgroundImageId = usePreferencesStore((s) => s.backgroundImageId);
  const backgroundOpacity = usePreferencesStore((s) => s.backgroundOpacity);
  const backgroundBlur = usePreferencesStore((s) => s.backgroundBlur);

  const handleThemeFiles = async (files: FileList | null) => {
    setImportError(null);
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const result = validateTheme(parsed);
        if (!result.ok) {
          setImportError(`${file.name}: ${result.error}`);
          return;
        }
        await saveCustomTheme(result.theme);
        setThemeId(result.theme.id);
      } catch (e) {
        setImportError(
          t("themes.errors.read", {
            name: file.name,
            error: e instanceof Error ? e.message : t("themes.errors.unknown"),
          }),
        );
        return;
      }
    }
  };

  const onPickThemeFile = () => fileInputRef.current?.click();

  const onRemoveCustomTheme = async (id: string) => {
    if (themeId === id) setThemeId(DEFAULT_THEME_ID);
    await deleteCustomTheme(id);
    void deleteThemeFile(id);
  };

  const onPickBgFile = () => bgInputRef.current?.click();

  const handleBgFiles = async (files: FileList | null) => {
    setBgError(null);
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith("image/")) {
      setBgError(t("themes.errors.notImage", { name: file.name }));
      return;
    }
    try {
      const prev = backgroundImageId;
      const { id } = await importBgImageFromFile(file);
      await setBackgroundImageId(id);
      await setBackgroundKind("image");
      if (prev && prev !== id) await deleteBgImage(prev).catch(() => undefined);
    } catch (e) {
      setBgError(
        e instanceof Error ? e.message : t("themes.errors.importImage"),
      );
    }
  };

  const onRemoveBackground = async () => {
    setBgError(null);
    const prev = backgroundImageId;
    await setBackgroundKind("none");
    await setBackgroundImageId(null);
    if (prev) await deleteBgImage(prev).catch(() => undefined);
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title={t("themes.header.title")}
        description={t("themes.header.description")}
      />

      <fieldset
        aria-label={t("themes.theme.filesAria")}
        className="flex flex-col gap-2"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          e.preventDefault();
          void handleThemeFiles(e.dataTransfer.files);
        }}
      >
        <div className="flex items-center justify-between">
          <Label>{t("themes.theme.label")}</Label>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-[11px] duration-control ease-standard"
              onClick={onCreateTheme}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={11} strokeWidth={2} />
              {t("themes.theme.create")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px] duration-control ease-standard"
              onClick={onPickThemeFile}
            >
              {t("themes.theme.import")}
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".terax-theme,.json,application/json"
            className="hidden"
            onChange={(e) => {
              void handleThemeFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        {importError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
            {importError}
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          {themes.map((theme) => {
            const v =
              theme.variants[resolvedMode] ??
              theme.variants.dark ??
              theme.variants.light;
            const c = v?.colors;
            const swatchBg = c?.background ?? "var(--background)";
            const swatchFg = c?.foreground ?? "var(--foreground)";
            const swatchAccent = c?.primary ?? c?.accent ?? "var(--accent)";
            const swatchMuted = c?.muted ?? "var(--muted)";
            const selected = themeId === theme.id;
            const isCustom = customIds.has(theme.id);
            return (
              <div
                key={theme.id}
                className="group relative"
              >
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setThemeId(theme.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg border p-2.5 text-left transition-[color,background-color,border-color,box-shadow] duration-control ease-standard focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    isCustom && "pr-16",
                    selected
                      ? "border-foreground/60 ring-1 ring-foreground/20"
                      : "border-border/60 hover:border-border",
                  )}
                >
                  <div
                    className="flex h-10 w-14 shrink-0 items-center justify-center gap-1 rounded-md border border-border/40"
                    style={{ background: swatchBg }}
                  >
                    <span
                      className="h-5 w-2 rounded-sm"
                      style={{ background: swatchAccent }}
                    />
                    <span
                      className="h-5 w-2 rounded-sm"
                      style={{ background: swatchFg, opacity: 0.7 }}
                    />
                    <span
                      className="h-5 w-2 rounded-sm"
                      style={{ background: swatchMuted }}
                    />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12.5px] font-medium">
                      {theme.name}
                    </span>
                    {theme.description ? (
                      <span className="truncate text-[11px] text-muted-foreground">
                        {theme.description}
                      </span>
                    ) : null}
                  </div>
                </button>
                {isCustom ? (
                  <span className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity duration-control ease-standard group-hover:opacity-100 group-focus-within:opacity-100">
                    <button
                      type="button"
                      aria-label={t("themes.theme.editAria", {
                        name: theme.name,
                      })}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditTheme(theme.id);
                      }}
                    >
                      <HugeiconsIcon
                        icon={Edit02Icon}
                        size={12}
                        strokeWidth={1.75}
                      />
                    </button>
                    <button
                      type="button"
                      aria-label={t("themes.theme.removeAria", {
                        name: theme.name,
                      })}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onRemoveCustomTheme(theme.id);
                      }}
                    >
                      ×
                    </button>
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <Label>{t("themes.editorTheme.label")}</Label>
            <span className="text-[11px] text-muted-foreground">
              {t("themes.editorTheme.description")}
            </span>
          </div>
          <Select
            value={editorThemePref}
            onValueChange={(v) => void setEditorTheme(v as EditorThemePref)}
          >
            <SelectTrigger size="sm" className="h-8 w-44 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EDITOR_THEME_AUTO} className="text-[12px]">
                {t("themes.editorTheme.auto")}
              </SelectItem>
              <SelectSeparator />
              {[...EDITOR_THEMES]
                .sort(
                  (a, b) =>
                    (EDITOR_THEME_MODE[a] === "both" ||
                    EDITOR_THEME_MODE[a] === resolvedMode
                      ? 0
                      : 1) -
                    (EDITOR_THEME_MODE[b] === "both" ||
                    EDITOR_THEME_MODE[b] === resolvedMode
                      ? 0
                      : 1),
                )
                .map((id) => (
                  <SelectItem
                    key={id}
                    value={id}
                    disabled={
                      EDITOR_THEME_MODE[id] !== "both" &&
                      EDITOR_THEME_MODE[id] !== resolvedMode
                    }
                    className="text-[12px]"
                  >
                    {EDITOR_THEME_LABELS[id]}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <fieldset
        aria-label={t("themes.background.filesAria")}
        className="flex flex-col gap-2"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          e.preventDefault();
          void handleBgFiles(e.dataTransfer.files);
        }}
      >
        <div className="flex items-center justify-between">
          <Label>{t("themes.background.label")}</Label>
          <div className="flex items-center gap-2">
            {backgroundKind === "image" && backgroundImageId ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px] text-muted-foreground duration-control ease-standard hover:text-destructive"
                onClick={() => void onRemoveBackground()}
              >
                {t("themes.background.remove")}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px] duration-control ease-standard"
              onClick={onPickBgFile}
            >
              {backgroundKind === "image"
                ? t("themes.background.replace")
                : t("themes.background.choose")}
            </Button>
            <input
              ref={bgInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                void handleBgFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        </div>
        {bgError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
            {bgError}
          </div>
        ) : null}
        {backgroundKind === "image" && backgroundImageId ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11.5px] text-muted-foreground">
                {t("themes.background.opacity")}
              </span>
              <span className="tabular-nums text-[11px] text-muted-foreground">
                {Math.round(backgroundOpacity * 100)}%
              </span>
            </div>
            <Slider
              value={[backgroundOpacity]}
              min={0}
              max={1}
              step={0.01}
              onValueChange={(v) => void setBackgroundOpacity(v[0] ?? 0)}
            />
            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-[11.5px] text-muted-foreground">
                {t("themes.background.blur")}
              </span>
              <span className="tabular-nums text-[11px] text-muted-foreground">
                {backgroundBlur}px
              </span>
            </div>
            <Slider
              value={[backgroundBlur]}
              min={0}
              max={64}
              step={1}
              onValueChange={(v) => void setBackgroundBlur(v[0] ?? 0)}
            />
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {t("themes.background.dropHint")}
          </p>
        )}
      </fieldset>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}

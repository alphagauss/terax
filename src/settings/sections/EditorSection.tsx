/**
 * 本文件呈现编辑器设置，包括编辑行为、保存和格式化选项。
 * 仅负责将偏好状态绑定到界面，所有用户可见的固定文案均由翻译资源提供。
 */

import { Hint } from "@/components/controls/tooltip";
import { Input } from "@/components/controls/input";
import { Button } from "@/components/controls/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/controls/select";
import { Switch } from "@/components/ui/switch";
import { EXPOSED_LANGUAGES } from "@/modules/editor/lib/languageDefinitions";
import {
  FORMATTER_LABELS,
  FORMATTERS,
} from "@/modules/editor/lib/externalFormat";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AUTO_SAVE_DELAY_MAX,
  AUTO_SAVE_DELAY_MIN,
  clampAutoSaveDelay,
  EDITOR_FONT_SIZES,
  type DiffViewMode,
  type EditorFormatter,
  setEditorAutoSave,
  setEditorAutoSaveDelay,
  setEditorCustomFormatCommand,
  setEditorFontSize,
  setEditorFormatOnSave,
  setEditorFormatter,
  setEditorFormatterByLang,
  setEditorWordWrap,
  setDiffViewMode,
  setVimMode,
} from "@/modules/settings/store";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LspServersGroup } from "@/settings/components/LspServersGroup";
import { PageHeader } from "@/components/layout/PageHeader";
import { SettingGroup } from "@/components/settings/SettingGroup";
import { SettingRow } from "@/components/settings/SettingRow";

const AUTO_SAVE_STEP = 100;

/** 展示编辑器偏好分组，条件字段随保存与格式化选项显示。 */
export function EditorSection() {
  const { t } = useTranslation();
  const editorFontSize = usePreferencesStore((s) => s.editorFontSize);
  const vimMode = usePreferencesStore((s) => s.vimMode);
  const editorWordWrap = usePreferencesStore((s) => s.editorWordWrap);
  const diffViewMode = usePreferencesStore((s) => s.diffViewMode);
  const editorAutoSave = usePreferencesStore((s) => s.editorAutoSave);
  const editorAutoSaveDelay = usePreferencesStore((s) => s.editorAutoSaveDelay);
  const editorFormatOnSave = usePreferencesStore((s) => s.editorFormatOnSave);
  const editorFormatter = usePreferencesStore((s) => s.editorFormatter);
  const editorFormatterByLang = usePreferencesStore(
    (s) => s.editorFormatterByLang,
  );
  const usesCustom =
    editorFormatter === "custom" ||
    Object.values(editorFormatterByLang).includes("custom");

  return (
    <div className="flex flex-col gap-section">
      <PageHeader
        title={t("editor.header.title")}
        description={t("editor.header.description")}
      />

      <SettingGroup title={t("editor.appearance.label")}>
        <SettingRow
          title={t("editor.appearance.fontSize.title")}
          description={t("editor.appearance.fontSize.description")}
        >
          <Select
            value={String(editorFontSize)}
            onValueChange={(v) => void setEditorFontSize(Number(v))}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EDITOR_FONT_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("editor.editing.label")}>
        <SettingRow
          title={t("editor.editing.vimMode.title")}
          description={t("editor.editing.vimMode.description")}
        >
          <Switch
            checked={vimMode}
            onCheckedChange={(v) => void setVimMode(v)}
          />
        </SettingRow>
        <SettingRow
          title={t("editor.editing.wordWrap.title")}
          description={t("editor.editing.wordWrap.description")}
        >
          <Switch
            checked={editorWordWrap}
            onCheckedChange={(v) => void setEditorWordWrap(v)}
          />
        </SettingRow>
        <SettingRow
          title={t("editor.editing.diffView.title")}
          description={t("editor.editing.diffView.description")}
        >
          <Select
            value={diffViewMode}
            onValueChange={(v) => void setDiffViewMode(v as DiffViewMode)}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inline">
                {t("editor.editing.diffView.inline")}
              </SelectItem>
              <SelectItem value="split">
                {t("editor.editing.diffView.sideBySide")}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("editor.saving.label")}>
        <SettingRow
          title={t("editor.saving.autoSave.title")}
          description={t("editor.saving.autoSave.description")}
        >
          <Switch
            checked={editorAutoSave}
            onCheckedChange={(v) => void setEditorAutoSave(v)}
          />
        </SettingRow>
        {editorAutoSave && (
          <AutoSaveDelayInput
            value={editorAutoSaveDelay}
            onChange={(v) => void setEditorAutoSaveDelay(v)}
          />
        )}
        <SettingRow
          title={t("editor.saving.formatOnSave.title")}
          description={t("editor.saving.formatOnSave.description")}
        >
          <Switch
            checked={editorFormatOnSave}
            onCheckedChange={(v) => void setEditorFormatOnSave(v)}
          />
        </SettingRow>
        {editorFormatOnSave && (
          <>
            <SettingRow
              title={t("editor.saving.formatter.title")}
              description={t("editor.saving.formatter.description")}
            >
              <FormatterSelect
                value={editorFormatter}
                onChange={(v) => void setEditorFormatter(v)}
              />
            </SettingRow>
            {usesCustom && <CustomFormatCommandInput />}
            <FormatterOverrides />
          </>
        )}
      </SettingGroup>

      <LspServersGroup />
    </div>
  );
}

const FORMATTER_OPTIONS: EditorFormatter[] = [
  "lsp",
  ...(Object.keys(FORMATTERS) as EditorFormatter[]),
  "custom",
];

function FormatterSelect({
  value,
  onChange,
}: {
  value: EditorFormatter;
  onChange: (v: EditorFormatter) => void;
}) {
  const { t } = useTranslation();

  return (
    <Select value={value} onValueChange={(v) => onChange(v as EditorFormatter)}>
      <SelectTrigger className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {FORMATTER_OPTIONS.map((id) => (
          <SelectItem key={id} value={id}>
            {id === "lsp"
              ? t("editor.saving.formatter.lsp")
              : id === "custom"
                ? t("editor.saving.formatter.custom")
                : FORMATTER_LABELS[id]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CustomFormatCommandInput() {
  const { t } = useTranslation();
  const stored = usePreferencesStore((s) => s.editorCustomFormatCommand);
  const [draft, setDraft] = useState(stored);

  useEffect(() => {
    setDraft(stored);
  }, [stored]);

  return (
    <SettingRow
      title={t("editor.saving.customCommand.title")}
      description={t("editor.saving.customCommand.description")}
    >
      <Input
        value={draft}
        placeholder="mytool --fix {file}"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== stored) void setEditorCustomFormatCommand(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-64 font-mono"
      />
    </SettingRow>
  );
}

function FormatterOverrides() {
  const { t } = useTranslation();
  const byLang = usePreferencesStore((s) => s.editorFormatterByLang);
  const entries = Object.entries(byLang);
  const unused = EXPOSED_LANGUAGES.filter((l) => !(l.ext in byLang));

  const update = (next: Record<string, EditorFormatter>) =>
    void setEditorFormatterByLang(next);

  return (
    <>
      <SettingRow
        title={t("editor.saving.languageOverrides.title")}
        description={t("editor.saving.languageOverrides.description")}
      >
        <Button
          type="button"
          disabled={unused.length === 0}
          variant="outline"
          onClick={() => {
            const first = unused[0];
            if (first) update({ ...byLang, [first.ext]: "lsp" });
          }}
        >
          {t("editor.saving.languageOverrides.add")}
        </Button>
      </SettingRow>
      {entries.map(([lang, formatter]) => (
        <div
          key={lang}
          className="flex flex-wrap items-center justify-end gap-2 px-3 py-2"
        >
          <Select
            value={lang}
            onValueChange={(nextLang) => {
              if (nextLang === lang) return;
              const next = { ...byLang };
              delete next[lang];
              next[nextLang] = formatter;
              update(next);
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPOSED_LANGUAGES.filter(
                (l) => l.ext === lang || !(l.ext in byLang),
              ).map((l) => (
                <SelectItem key={l.ext} value={l.ext}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormatterSelect
            value={formatter}
            onChange={(v) => update({ ...byLang, [lang]: v })}
          />
          <Hint content={t("editor.saving.languageOverrides.remove")}>
            <button
              aria-label={t("editor.saving.languageOverrides.remove")}
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => {
                const next = { ...byLang };
                delete next[lang];
                update(next);
              }}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
            </button>
          </Hint>
        </div>
      ))}
    </>
  );
}

function AutoSaveDelayInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const clamped = clampAutoSaveDelay(n);
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <SettingRow
      title={t("editor.saving.autoSaveDelay.title")}
      description={t("editor.saving.autoSaveDelay.description")}
    >
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={AUTO_SAVE_DELAY_MIN}
          max={AUTO_SAVE_DELAY_MAX}
          step={AUTO_SAVE_STEP}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
          }}
          className="w-20 border border-border bg-background px-2.5 text-right tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        <span className="text-[11px] text-muted-foreground">
          {t("editor.saving.autoSaveDelay.unit")}
        </span>
      </div>
    </SettingRow>
  );
}

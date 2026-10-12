/**
 * 本文件渲染内置 Provider 配置卡片。
 * 卡片按凭据类型显示密钥交互，并通过子内容组合地址和模型设置。
 */

import { Hint } from "@/components/controls/tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/controls/button";
import { Input } from "@/components/controls/input";
import { Spinner } from "@/components/ui/spinner";
import { ProviderIcon } from "@/modules/ai/components/ProviderIcon";
import type { ProviderInfo } from "@/modules/ai/config";
import {
  ArrowUpRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Edit02Icon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { reportError } from "@/lib/errors";
import { useTranslation } from "react-i18next";

type Props = {
  provider: ProviderInfo;
  currentKey: string | null;
  configured: boolean;
  onSave: (key: string) => Promise<void>;
  onRemove: () => void;
  children?: ReactNode;
};

function maskKey(key: string): string {
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}${"•".repeat(8)}${key.slice(-4)}`;
}

/** 内置 Provider 配置卡片，按凭据类型显示控件并承载地址和模型设置。 */
export function ProviderKeyCard({
  provider,
  currentKey,
  configured,
  onSave,
  onRemove,
  children,
}: Props) {
  const { t } = useTranslation();
  const credential = provider.credential;
  const usesApiKey = credential.adapter === "api-key";
  const [editing, setEditing] = useState(usesApiKey && !currentKey);
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyPrefix =
    credential.adapter === "api-key" ? credential.keyPrefix : null;

  useEffect(() => {
    setEditing(usesApiKey && !currentKey);
  }, [currentKey, usesApiKey]);

  const submit = async () => {
    if (!usesApiKey) return;
    const trimmed = value.trim();
    if (!trimmed) {
      setError(t("models.card.enterKey"));
      return;
    }
    if (keyPrefix && !trimmed.startsWith(keyPrefix)) {
      setError(
        t("models.card.keyPrefixHint", {
          provider: provider.label,
          prefix: keyPrefix,
        }),
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      setValue("");
      setReveal(false);
    } catch (e) {
      reportError(t("common:errors.saveFailed"), { error: e });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderIcon provider={provider.id} size={15} />
        <span className="text-[12.5px] font-medium">{provider.label}</span>
        {configured ? (
          <Badge
            variant="outline"
            className="ml-1 h-4 gap-1 border-border/60 bg-muted/40 px-1.5 text-[10px] font-normal text-muted-foreground"
          >
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              size={9}
              strokeWidth={2}
            />
            {t("common.configured")}
          </Badge>
        ) : null}
        <button
          type="button"
          onClick={() => void openUrl(provider.consoleUrl)}
          className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t(usesApiKey ? "models.card.getKey" : "models.card.docs")}
          <HugeiconsIcon
            icon={ArrowUpRight01Icon}
            size={11}
            strokeWidth={1.75}
          />
        </button>
        <Hint content={t("models.card.removeProvider")}>
          <Button
            aria-label={t("models.card.removeProvider")}
            size="icon-sm"
            variant="ghost-destructive-hover"
            onClick={onRemove}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
          </Button>
        </Hint>
      </div>

      {usesApiKey && editing ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1.5">
            <div className="relative flex-1">
              <Input
                type={reveal ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  keyPrefix ? `${keyPrefix}…` : t("models.card.pasteKey")
                }
                value={value}
                disabled={saving}
                onChange={(e) => {
                  setValue(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  } else if (e.key === "Escape" && currentKey) {
                    setValue("");
                    setReveal(false);
                    setError(null);
                    setEditing(false);
                  }
                }}
                className="pr-7 font-mono"
              />
              <button
                type="button"
                onClick={() => setReveal((v) => !v)}
                tabIndex={-1}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={
                  reveal ? t("models.card.hideKey") : t("models.card.showKey")
                }
              >
                <HugeiconsIcon
                  icon={reveal ? ViewOffSlashIcon : ViewIcon}
                  size={12}
                  strokeWidth={1.75}
                />
              </button>
            </div>
            <Button
              onClick={() => void submit()}
              disabled={saving || !value.trim()}
              className="gap-1"
            >
              {saving ? <Spinner className="size-3" /> : null}
              {t("common.save")}
            </Button>
          </div>
          {error ? (
            <p className="text-[11px] text-destructive">{error}</p>
          ) : null}
        </div>
      ) : usesApiKey ? (
        <div className="flex items-center gap-1.5">
          <code className="flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {maskKey(currentKey ?? "")}
          </code>
          <Hint content={t("models.card.replace")}>
            <Button
              aria-label={t("models.card.replace")}
              size="icon-sm"
              variant="ghost"
              onClick={() => setEditing(true)}
            >
              <HugeiconsIcon icon={Edit02Icon} size={12} strokeWidth={1.75} />
            </Button>
          </Hint>
        </div>
      ) : null}
      {children}
    </div>
  );
}

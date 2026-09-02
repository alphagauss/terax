/**
 * 本文件实现 Provider 的多模型添加控件。
 * 服务端发现结果保持临时，只有用户明确添加的模型才写入设置。
 */

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  type ConfiguredModel,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  normalizeModelId,
} from "@/modules/ai/config";
import { ModelCatalogError, modelCatalog } from "@/modules/ai/lib/modelCatalog";
import type { ResolvedProviderConnection } from "@/modules/ai/providerRegistry";
import {
  Add01Icon,
  ArrowDown01Icon,
  Cancel01Icon,
  ReloadIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

type CatalogStatus = "idle" | "loading" | "refreshing" | "ready" | "error";
const MAX_VISIBLE_MODELS = 100;

type Props = {
  connection: ResolvedProviderConnection | null;
  models: readonly ConfiguredModel[];
  onChange: (models: ConfiguredModel[]) => Promise<void>;
};

function catalogErrorKey(error: unknown): string {
  if (!(error instanceof ModelCatalogError)) return "network";
  return error.kind;
}

/** 管理一个 Provider 的已添加模型和远端发现列表。 */
export function ProviderModelPicker({ connection, models, onChange }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  const [status, setStatus] = useState<CatalogStatus>("idle");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestVersion = useRef(0);
  const savingRef = useRef(false);
  const connectionKey = connection
    ? `${connection.instanceId}\u0000${connection.baseURL}`
    : "";

  useEffect(() => {
    requestVersion.current += 1;
    if (!connectionKey) setQuery("");
    setRemoteModels([]);
    setStatus("idle");
    setErrorKey(null);
    setSaveFailed(false);
  }, [connectionKey]);

  const load = useCallback(
    async (refresh: boolean) => {
      if (!connection) return;
      const version = ++requestVersion.current;
      setStatus(remoteModels.length > 0 ? "refreshing" : "loading");
      setErrorKey(null);
      try {
        const result = await modelCatalog.list(connection, refresh);
        if (version !== requestVersion.current) return;
        setRemoteModels(result);
        setStatus("ready");
      } catch (error) {
        if (version !== requestVersion.current) return;
        setStatus("error");
        setErrorKey(catalogErrorKey(error));
      }
    },
    [connection, remoteModels.length],
  );

  const handleOpenChange = (next: boolean) => {
    if (next && connection) {
      void load(false);
      return;
    }
    if (!next) {
      requestVersion.current += 1;
      setRemoteModels([]);
      setStatus("idle");
      setErrorKey(null);
      setSaveFailed(false);
    }
  };

  const addedIds = useMemo(
    () => new Set(models.map((model) => model.id)),
    [models],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const manualCandidate = normalizeModelId(query);
  const filteredRemote = remoteModels.filter((model) =>
    model.toLowerCase().includes(normalizedQuery),
  );

  const addModel = async (id: string, source: ConfiguredModel["source"]) => {
    const normalized = normalizeModelId(id);
    if (!normalized || addedIds.has(normalized) || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveFailed(false);
    try {
      await onChange([
        ...models,
        { id: normalized, source, contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW },
      ]);
      setQuery("");
    } catch {
      setSaveFailed(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const removeModel = async (id: string) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveFailed(false);
    try {
      await onChange(models.filter((model) => model.id !== id));
    } catch {
      setSaveFailed(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const addManual = () => {
    void addModel(query, "manual");
  };

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="h-8 flex-1 justify-between gap-2 px-2.5 text-[11.5px]"
        >
          <span className="truncate">
            {models.length > 0
              ? t("models.catalog.configuredCount", { count: models.length })
              : t("models.catalog.addModels")}
          </span>
          <HugeiconsIcon icon={ArrowDown01Icon} size={11} strokeWidth={2} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-80 max-w-[calc(100vw-1rem)] gap-0 overflow-hidden rounded-xl p-0"
      >
        <div className="flex items-center gap-1.5 border-b border-border/60 p-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              addManual();
            }}
            placeholder={t("models.catalog.searchOrEnter")}
            spellCheck={false}
            className="h-7 flex-1 font-mono text-[11px]"
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => void load(true)}
            disabled={
              !connection || status === "loading" || status === "refreshing"
            }
            title={t("models.catalog.refresh")}
            className="size-7"
          >
            {status === "loading" || status === "refreshing" ? (
              <Spinner className="size-3" />
            ) : (
              <HugeiconsIcon icon={ReloadIcon} size={12} strokeWidth={1.75} />
            )}
          </Button>
        </div>

        <div className="max-h-72 overflow-y-auto py-1">
          {saveFailed ? (
            <CatalogMessage destructive>
              {t("models.catalog.error.save")}
            </CatalogMessage>
          ) : null}
          {models.length > 0 ? (
            <ModelSection title={t("models.catalog.configured")}>
              {models.map((model) => (
                <ModelRow
                  key={model.id}
                  id={model.id}
                  badge={t(`models.catalog.source.${model.source}`)}
                  actionLabel={t("models.catalog.remove", { id: model.id })}
                  actionIcon={Cancel01Icon}
                  disabled={saving}
                  onAction={() => void removeModel(model.id)}
                />
              ))}
            </ModelSection>
          ) : null}

          <ModelSection title={t("models.catalog.available")}>
            {!connection ? (
              <CatalogMessage>
                {t("models.catalog.configureFirst")}
              </CatalogMessage>
            ) : status === "loading" ? (
              <CatalogMessage>{t("models.catalog.loading")}</CatalogMessage>
            ) : errorKey ? (
              <CatalogMessage destructive>
                {t(`models.catalog.error.${errorKey}`)}
              </CatalogMessage>
            ) : filteredRemote.length === 0 ? (
              <CatalogMessage>
                {status === "ready"
                  ? t("models.catalog.empty")
                  : t("models.catalog.openToLoad")}
              </CatalogMessage>
            ) : (
              <>
                {filteredRemote.slice(0, MAX_VISIBLE_MODELS).map((model) => {
                  const added = addedIds.has(model);
                  return (
                    <ModelRow
                      key={model}
                      id={model}
                      badge={added ? t("models.catalog.added") : undefined}
                      actionLabel={t(
                        added ? "models.catalog.remove" : "models.catalog.add",
                        { id: model },
                      )}
                      actionIcon={added ? Cancel01Icon : Add01Icon}
                      disabled={saving}
                      onAction={() =>
                        void (added
                          ? removeModel(model)
                          : addModel(model, "discovered"))
                      }
                    />
                  );
                })}
                {filteredRemote.length > MAX_VISIBLE_MODELS ? (
                  <CatalogMessage>
                    {t("models.catalog.refine", {
                      count: filteredRemote.length,
                    })}
                  </CatalogMessage>
                ) : null}
              </>
            )}
          </ModelSection>
        </div>

        {manualCandidate && !addedIds.has(manualCandidate) ? (
          <button
            type="button"
            onClick={addManual}
            disabled={saving}
            className="flex items-center gap-2 border-t border-border/60 px-3 py-2 text-left text-[11px] hover:bg-interactive-hover"
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
            <span className="truncate font-mono">{manualCandidate}</span>
            <span className="ml-auto text-muted-foreground">
              {t("models.catalog.addManual")}
            </span>
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function ModelSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-1">
      <div className="px-3 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </div>
      {children}
    </div>
  );
}

function ModelRow({
  id,
  badge,
  actionLabel,
  actionIcon,
  disabled,
  onAction,
}: {
  id: string;
  badge?: string;
  actionLabel: string;
  actionIcon: typeof Add01Icon;
  disabled: boolean;
  onAction: () => void;
}) {
  return (
    <div className="group flex items-center gap-2 px-3 py-1.5 hover:bg-interactive-hover">
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
        {id}
      </span>
      {badge ? (
        <span className="shrink-0 text-[9.5px] text-muted-foreground">
          {badge}
        </span>
      ) : null}
      <button
        type="button"
        onClick={onAction}
        aria-label={actionLabel}
        title={actionLabel}
        disabled={disabled}
        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-active hover:text-foreground"
      >
        <HugeiconsIcon icon={actionIcon} size={12} strokeWidth={1.75} />
      </button>
    </div>
  );
}

function CatalogMessage({
  children,
  destructive = false,
}: {
  children: React.ReactNode;
  destructive?: boolean;
}) {
  return (
    <div
      className={cn(
        "px-3 py-3 text-[10.5px] text-muted-foreground",
        destructive && "text-destructive",
      )}
    >
      {children}
    </div>
  );
}

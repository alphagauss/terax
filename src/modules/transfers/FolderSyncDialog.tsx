/** 选择目录内容同步方向，预览只读差异，并交给原生后台任务执行。 */
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { HelpCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/controls/button";
import { Hint } from "@/components/controls/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/controls/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/controls/dialog";
import { pickDownloadDirectory } from "@/modules/transfers/dialogs";
import { formatTransferError } from "@/modules/transfers/errors";
import { formatBytes } from "@/modules/transfers/format";
import { transferNative } from "@/modules/transfers/native";
import { requestTransferPanel } from "@/modules/transfers/store";
import type {
  EnqueueTransferRequest,
  SyncPreview,
  TransferDirection,
} from "@/modules/transfers/types";

const DIRECTORY_PRESETS = [
  "node_modules",
  ".venv",
  "target",
  "dist",
  "build",
] as const;

const PREVIEW_GROUPS = ["transfer", "skip", "conflict"] as const;
const ACTION_COLORS = {
  add: "text-success",
  update: "text-primary",
  skip: "text-muted-foreground",
  conflict: "text-destructive",
} as const;

function SyncHelp({ content }: { content: string }) {
  return (
    <Hint content={content}>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={content}>
        <HugeiconsIcon icon={HelpCircleIcon} size={14} strokeWidth={2} />
      </Button>
    </Hint>
  );
}

export function FolderSyncDialog({
  remotePath,
  onClose,
}: {
  remotePath: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(["explorer", "statusbar"]);
  const excludesId = useId();
  const [localPath, setLocalPath] = useState("");
  const [direction, setDirection] = useState<TransferDirection>("upload");
  const [respectGitignore, setRespectGitignore] = useState(true);
  const [excludeGit, setExcludeGit] = useState(true);
  const [excludeDirectories, setExcludeDirectories] = useState<string[]>([]);
  const [excludes, setExcludes] = useState<string[]>([]);
  const [draftExclude, setDraftExclude] = useState("");
  const [excludeError, setExcludeError] = useState("");
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [previewGroup, setPreviewGroup] =
    useState<(typeof PREVIEW_GROUPS)[number]>("transfer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const invalidate = () => {
    generation.current += 1;
    setPreview(null);
    setError("");
  };
  const request = (): EnqueueTransferRequest => ({
    direction,
    strategy: "archive",
    sources: [direction === "upload" ? localPath : remotePath],
    destination: direction === "upload" ? remotePath : localPath,
    sync: {
      excludes: [...new Set([...(excludeGit ? [".git"] : []), ...excludes])],
      excludeDirectories,
      respectGitignore,
    },
  });
  const addExclude = () => {
    const name = draftExclude.trim();
    if (
      !name ||
      name === "." ||
      name === ".." ||
      /[/\\,\p{Cc}]/u.test(name) ||
      new TextEncoder().encode(name).length > 255 ||
      excludes.length >= 120
    ) {
      setExcludeError(t("sync.invalidExclude"));
      return;
    }
    if (excludes.includes(name) || (excludeGit && name === ".git")) {
      setExcludeError(t("sync.duplicateExclude"));
      return;
    }
    invalidate();
    setExcludes([...excludes, name]);
    setDraftExclude("");
    setExcludeError("");
  };
  const run = async (start: boolean) => {
    const current = generation.current;
    setBusy(true);
    setError("");
    try {
      if (start) {
        const task = await transferNative.enqueue(request());
        requestTransferPanel(task.id);
        if (current === generation.current) onClose();
      } else {
        const result = await transferNative.syncPreview(request());
        if (current === generation.current) {
          setPreview(result);
          setPreviewGroup("transfer");
        }
      }
    } catch (error) {
      if (current === generation.current)
        setError(formatTransferError(error, t));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const previewCounts = {
    transfer: (preview?.added ?? 0) + (preview?.updated ?? 0),
    skip: preview?.skipped ?? 0,
    conflict: preview?.conflicts ?? 0,
  };
  const visibleItems = preview?.items.filter((item) =>
    previewGroup === "transfer"
      ? item.action === "add" || item.action === "update"
      : item.action === previewGroup,
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          generation.current += 1;
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-1">
            <DialogTitle>{t("sync.title")}</DialogTitle>
            <SyncHelp content={t("sync.description")} />
          </div>
          <DialogDescription className="sr-only">
            {t("sync.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="space-y-1">
            <div>{t("sync.remote")}</div>
            <div className="break-all text-muted-foreground">{remotePath}</div>
          </div>
          <div className="space-y-1">
            <div>{t("sync.local")}</div>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 break-all text-muted-foreground">
                {localPath || t("sync.chooseDirectory")}
              </div>
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  const current = generation.current;
                  setBusy(true);
                  try {
                    const path = await pickDownloadDirectory(
                      t("sync.chooseDirectory"),
                    );
                    if (current !== generation.current) return;
                    if (path) {
                      invalidate();
                      setLocalPath(path);
                    }
                    setBusy(false);
                  } catch (error) {
                    if (current === generation.current) {
                      setError(formatTransferError(error, t));
                      setBusy(false);
                    }
                  }
                }}
              >
                {t("sync.chooseDirectory")}
              </Button>
            </div>
          </div>
          <fieldset
            className="flex flex-wrap items-center gap-2"
            aria-label={t("sync.direction")}
          >
            {(["upload", "download"] as const).map((value) => (
              <Button
                key={value}
                variant={direction === value ? "secondary" : "outline"}
                aria-pressed={direction === value}
                disabled={busy}
                onClick={() => {
                  invalidate();
                  setDirection(value);
                }}
              >
                {t(`sync.${value}`)}
              </Button>
            ))}
            <SyncHelp content={t("sync.rule")} />
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="mb-2">
              <span className="inline-flex items-center gap-1">
                {t("sync.excludeOptions")}
                <SyncHelp content={t("sync.excludeOptionsHint")} />
              </span>
            </legend>
            <div className="divide-y divide-border">
              <div className="flex items-center gap-2 py-2">
                <Checkbox
                  id={`${excludesId}-ignore`}
                  checked={respectGitignore}
                  disabled={busy}
                  onCheckedChange={(checked) => {
                    invalidate();
                    setRespectGitignore(checked === true);
                  }}
                />
                <label htmlFor={`${excludesId}-ignore`}>
                  {t("sync.respectGitignore")}
                </label>
                <SyncHelp content={t("sync.gitignoreHint")} />
              </div>
              <div className="flex items-center gap-2 py-2">
                <Checkbox
                  id={`${excludesId}-git`}
                  checked={excludeGit}
                  disabled={busy}
                  onCheckedChange={(checked) => {
                    invalidate();
                    setExcludeGit(checked === true);
                  }}
                />
                <label htmlFor={`${excludesId}-git`}>
                  {t("sync.excludeGit")}
                </label>
              </div>
              {DIRECTORY_PRESETS.map((name) => (
                <div key={name} className="flex items-center gap-2 py-2">
                  <Checkbox
                    id={`${excludesId}-${name}`}
                    checked={excludeDirectories.includes(name)}
                    disabled={busy}
                    onCheckedChange={(checked) => {
                      invalidate();
                      setExcludeDirectories(
                        checked === true
                          ? [...excludeDirectories, name]
                          : excludeDirectories.filter(
                              (value) => value !== name,
                            ),
                      );
                    }}
                  />
                  <label htmlFor={`${excludesId}-${name}`}>
                    {t("sync.excludeDirectory", { name })}
                  </label>
                </div>
              ))}
            </div>
          </fieldset>
          <div className="space-y-2">
            <div className="flex items-center gap-1">
              <label htmlFor={excludesId}>{t("sync.excludes")}</label>
              <SyncHelp content={t("sync.excludesHint")} />
            </div>
            <div className="flex gap-2">
              <Input
                id={excludesId}
                value={draftExclude}
                disabled={busy}
                placeholder={t("sync.excludePlaceholder")}
                onChange={(event) => {
                  setDraftExclude(event.target.value);
                  setExcludeError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addExclude();
                  }
                }}
              />
              <Button
                variant="outline"
                disabled={busy || !draftExclude.trim()}
                onClick={addExclude}
              >
                {t("sync.addExclude")}
              </Button>
            </div>
            {excludes.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {excludes.map((name) => (
                  <Button
                    key={name}
                    variant="secondary"
                    disabled={busy}
                    aria-label={t("sync.removeExclude", { name })}
                    onClick={() => {
                      invalidate();
                      setExcludes(excludes.filter((value) => value !== name));
                    }}
                  >
                    {name} ×
                  </Button>
                ))}
              </div>
            )}
            {!!draftExclude.trim() && !excludeError && (
              <p className="text-muted-foreground">
                {t("sync.pendingExcludeHint")}
              </p>
            )}
            {excludeError && (
              <p role="alert" className="text-destructive">
                {excludeError}
              </p>
            )}
          </div>
          {preview && (
            <div className="space-y-2" aria-live="polite">
              <p>
                {t("sync.summary", {
                  count: previewCounts.transfer,
                  bytes: formatBytes(preview.bytes),
                })}
              </p>
              <p className="text-muted-foreground">
                {t("sync.changeSummary", {
                  added: preview.added,
                  updated: preview.updated,
                })}
              </p>
              {preview.conflicts > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-destructive">{t("sync.conflictsHint")}</p>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => setPreviewGroup("conflict")}
                  >
                    {t("sync.viewConflicts")}
                  </Button>
                </div>
              )}
              <fieldset
                aria-label={t("sync.previewCategories")}
                className="flex flex-wrap gap-2"
              >
                {PREVIEW_GROUPS.map((group) => (
                  <Button
                    key={group}
                    variant={previewGroup === group ? "secondary" : "outline"}
                    size="sm"
                    aria-pressed={previewGroup === group}
                    onClick={() => setPreviewGroup(group)}
                  >
                    <span
                      className={
                        group === "conflict" && preview.conflicts > 0
                          ? "text-destructive"
                          : undefined
                      }
                    >
                      {t(`sync.previewGroups.${group}`, {
                        count: previewCounts[group],
                      })}
                    </span>
                  </Button>
                ))}
              </fieldset>
              <div
                key={previewGroup}
                className="max-h-48 overflow-auto overscroll-y-contain"
              >
                {visibleItems?.length ? (
                  <ul className="divide-y divide-border">
                    {visibleItems.map((item) => (
                      <li
                        key={item.path}
                        className="flex items-center gap-3 py-1.5"
                      >
                        <span
                          className={`w-16 shrink-0 ${ACTION_COLORS[item.action]}`}
                        >
                          {t(`sync.actions.${item.action}`)}
                        </span>
                        <Hint
                          content={
                            <span className="min-w-0 break-all">
                              {item.path}
                            </span>
                          }
                        >
                          <span
                            className={`min-w-0 truncate ${item.action === "skip" ? "text-muted-foreground" : ""}`}
                          >
                            {item.path}
                          </span>
                        </Hint>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-2 text-muted-foreground">
                    {t(
                      previewCounts[previewGroup] > 0
                        ? "sync.omittedPreviewItems"
                        : "sync.emptyPreviewGroup",
                    )}
                  </p>
                )}
              </div>
              {preview.truncated && (
                <p className="text-muted-foreground">{t("sync.truncated")}</p>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy || !localPath || !!draftExclude.trim()}
            onClick={() => void run(false)}
          >
            {busy ? t("sync.working") : t("sync.preview")}
          </Button>
          <Button
            disabled={
              busy ||
              !!draftExclude.trim() ||
              !preview ||
              preview.conflicts > 0 ||
              preview.added + preview.updated === 0
            }
            onClick={() => void run(true)}
          >
            {t("sync.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

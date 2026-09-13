/**
 * 本文件实现状态栏文件传输概览、冲突决策和 Direct 失败项操作。
 * 面板关闭不会影响 Rust 后台任务，全局冲突对话框仍保持挂载；任务状态只订阅独立 Zustand slice。
 */

import { Hint } from "@/components/controls/tooltip";
import { Button } from "@/components/controls/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/controls/alert-dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import {
  ArrowDataTransferVerticalIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CleanIcon,
  Delete02Icon,
  Download01Icon,
  PauseIcon,
  PlayIcon,
  Refresh01Icon,
  Upload01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { TFunction } from "i18next";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  formatTransferError,
  formatTransferFailure,
} from "@/modules/transfers/errors";
import { transferNative } from "@/modules/transfers/native";
import { useTransferBridge, useTransferStore } from "@/modules/transfers/store";
import {
  hasExpandableTransferFailures,
  isActiveTransfer,
  type TransferConflict,
  type TransferConflictDecision,
  type TransferTask,
} from "@/modules/transfers/types";

/** 展示当前进程传输任务的聚合状态和行内控制。 */
export function TransferStatusControl() {
  const environmentKind = useWorkspaceEnvStore((state) => state.env.kind);
  if (environmentKind === "local") return null;
  return <TransferStatusPanel />;
}

/** 挂载传输事件桥、任务列表与全局冲突对话框。 */
function TransferStatusPanel() {
  const { t } = useTranslation("statusbar");
  const taskMap = useTransferStore((state) => state.tasks);
  const removeLocalMany = useTransferStore((state) => state.removeLocalMany);
  const panelOpen = useTransferStore((state) => state.panelOpen);
  const setPanelOpen = useTransferStore((state) => state.setPanelOpen);
  const [confirmClearAllOpen, setConfirmClearAllOpen] = useState(false);
  const [clearing, setClearing] = useState<"completed" | "all" | null>(null);
  useTransferBridge();
  const tasks = useMemo(
    () =>
      Object.values(taskMap).sort((left, right) => {
        const activeOrder =
          Number(isActiveTransfer(right)) - Number(isActiveTransfer(left));
        return activeOrder || right.createdAt - left.createdAt;
      }),
    [taskMap],
  );
  const active = tasks.filter(isActiveTransfer);
  const failed = tasks.filter(
    (task) =>
      task.status === "failed" || task.status === "completed_with_errors",
  ).length;
  const totalBytes = active.reduce((sum, task) => sum + task.totalBytes, 0);
  const transferredBytes = active.reduce(
    (sum, task) => sum + Math.min(task.transferredBytes, task.totalBytes),
    0,
  );
  const progress = totalBytes > 0 ? (transferredBytes / totalBytes) * 100 : 0;
  const showAggregateProgress =
    totalBytes > 0 &&
    active.every(
      (task) =>
        task.stage !== "queued" &&
        task.stage !== "scanning" &&
        task.stage !== "checking_conflicts",
    );
  const completedCount = tasks.filter(
    (task) =>
      task.status === "completed" || task.status === "completed_with_errors",
  ).length;
  const clearableCount = tasks.filter((task) => !isActiveTransfer(task)).length;
  const conflictTask = tasks
    .filter(
      (task) => task.status === "awaiting_decision" && task.conflict !== null,
    )
    .sort((left, right) => left.createdAt - right.createdAt)[0];
  const pendingConflict = conflictTask?.conflict;

  /** 清理指定范围的终态任务，并在成功后即时同步本地快照。 */
  const clearTasks = async (kind: "completed" | "all") => {
    setClearing(kind);
    try {
      const ids =
        kind === "completed"
          ? await transferNative.clearCompleted()
          : await transferNative.clearAll();
      removeLocalMany(ids);
    } catch (error) {
      toast.error(
        t("transfers.operationFailed", {
          error: formatTransferError(error, t),
        }),
      );
    } finally {
      setClearing(null);
    }
  };

  return (
    <Popover open={panelOpen} onOpenChange={setPanelOpen}>
      <PopoverTrigger asChild>
        <Hint content={t("transfers.title")}>
          <button
            type="button"
            className={cn(
              "flex h-6 items-center gap-1 rounded-sm px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground",
              failed > 0 && "text-destructive",
            )}
            aria-label={t("transfers.title")}
          >
            <HugeiconsIcon
              icon={ArrowDataTransferVerticalIcon}
              size={13}
              strokeWidth={1.8}
            />
            <span>
              {active.length > 0
                ? showAggregateProgress
                  ? t("transfers.activeSummary", {
                      count: active.length,
                      progress: Math.round(progress),
                    })
                  : t("transfers.activeCount", { count: active.length })
                : t("transfers.label")}
            </span>
            {failed > 0 ? (
              <span className="font-medium">
                {t("transfers.failedCount", { count: failed })}
              </span>
            ) : null}
          </button>
        </Hint>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="w-[430px] max-w-[calc(100vw-16px)] gap-0 overflow-hidden rounded-xl p-0"
      >
        <div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t("transfers.title")}</div>
            <div className="text-[11px] text-muted-foreground">
              {active.length > 0
                ? t("transfers.runningCount", { count: active.length })
                : t("transfers.noActive")}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {showAggregateProgress ? (
              <div className="mr-1 text-xs tabular-nums text-muted-foreground">
                {Math.round(progress)}%
              </div>
            ) : null}
            <Hint content={t("transfers.clearCompleted")}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t("transfers.clearCompleted")}
                disabled={completedCount === 0 || clearing !== null}
                onClick={() => void clearTasks("completed")}
              >
                <HugeiconsIcon icon={CleanIcon} size={13} strokeWidth={1.8} />
              </Button>
            </Hint>
            <Hint content={t("transfers.clearAll")}>
              <Button
                type="button"
                variant="ghost-destructive-hover"
                size="icon-xs"
                aria-label={t("transfers.clearAll")}
                disabled={clearableCount === 0 || clearing !== null}
                onClick={() => setConfirmClearAllOpen(true)}
              >
                <HugeiconsIcon
                  icon={Delete02Icon}
                  size={13}
                  strokeWidth={1.8}
                />
              </Button>
            </Hint>
          </div>
        </div>
        {tasks.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            {t("transfers.empty")}
          </div>
        ) : (
          <ScrollArea className="max-h-[380px]">
            <div className="divide-y divide-border/50">
              {tasks.map((task) => (
                <TransferTaskRow key={task.id} task={task} />
              ))}
            </div>
          </ScrollArea>
        )}
      </PopoverContent>
      <AlertDialog
        open={confirmClearAllOpen}
        onOpenChange={(open) => {
          if (!open && clearing === null) setConfirmClearAllOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("transfers.clearAllTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("transfers.clearAllDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("transfers.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmClearAllOpen(false);
                void clearTasks("all");
              }}
            >
              {t("transfers.clearAll")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {conflictTask && pendingConflict ? (
        <TransferConflictDialog
          key={pendingConflict.id}
          taskId={conflictTask.id}
          conflict={pendingConflict}
        />
      ) : null}
    </Popover>
  );
}

/** 展示一条聚合任务，并仅为 Direct 文件夹展开失败文件。 */
export function TransferTaskRow({ task }: { task: TransferTask }) {
  const { t } = useTranslation("statusbar");
  const removeLocal = useTransferStore((state) => state.removeLocal);
  const [failuresOpen, setFailuresOpen] = useState(false);
  const [failureActionPending, setFailureActionPending] = useState(false);
  const active = isActiveTransfer(task);
  const progress = transferProgress(task);
  const detail = task.currentFile
    ? basename(task.currentFile)
    : task.destination;
  const displayName =
    task.sourceCount > 1
      ? t("transfers.items", { count: task.sourceCount })
      : task.name;
  const hasPartialResult =
    (task.status === "failed" || task.status === "canceled") &&
    task.committedRoots > 0;
  const failureMessage = task.failure
    ? formatTransferFailure(task.failure, t)
    : null;
  const fileFailures = task.fileFailures.filter((failure) => !failure.ignored);
  const canExpandFailures =
    hasExpandableTransferFailures(task) && fileFailures.length > 0;

  const run = (operation: Promise<void>) => {
    void operation.catch((error) =>
      toast.error(
        t("transfers.operationFailed", {
          error: formatTransferError(error, t),
        }),
      ),
    );
  };
  const remove = () => {
    void transferNative
      .remove(task.id)
      .then(() => removeLocal(task.id))
      .catch((error) =>
        toast.error(
          t("transfers.operationFailed", {
            error: formatTransferError(error, t),
          }),
        ),
      );
  };
  const runFailureAction = (operation: () => Promise<void>) => {
    if (failureActionPending) return;
    setFailureActionPending(true);
    void operation()
      .catch((error) =>
        toast.error(
          t("transfers.operationFailed", {
            error: formatTransferError(error, t),
          }),
        ),
      )
      .finally(() => setFailureActionPending(false));
  };

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
            (task.status === "failed" ||
              task.status === "completed_with_errors") &&
              "bg-destructive/10 text-destructive",
          )}
        >
          <HugeiconsIcon
            icon={task.direction === "upload" ? Upload01Icon : Download01Icon}
            size={13}
            strokeWidth={1.8}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs font-medium">
              {displayName}
              <span className="ml-1 font-normal text-muted-foreground">
                · {t(`transfers.strategy.${task.strategy}`)}
              </span>
            </span>
            <span
              className={cn(
                "shrink-0 text-[10px] text-muted-foreground",
                (task.status === "failed" ||
                  task.status === "completed_with_errors") &&
                  "text-destructive",
              )}
            >
              {taskStateLabel(task, t)}
            </span>
          </div>
          <Hint content={detail}>
            <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
              {detail}
            </div>
          </Hint>
          {hasPartialResult ? (
            <div className="mt-1 text-[10px] text-foreground">
              {t("transfers.partialResult", {
                count: task.committedRoots,
                committed: task.committedRoots,
                total: task.totalRoots,
              })}
            </div>
          ) : null}
          {task.failure ? (
            <div className="mt-1 whitespace-pre-wrap break-all text-[10px] leading-4 text-destructive">
              {task.failure.detail}
            </div>
          ) : null}
          {!active && task.strategy === "direct" && task.isDirectory ? (
            <div
              className={cn(
                "mt-1 text-[10px] text-muted-foreground",
                (task.failedFiles > 0 || task.unprocessedFiles > 0) &&
                  "text-destructive",
              )}
            >
              {t("transfers.resultSummary", {
                completed: task.completedFiles,
                failed: task.failedFiles,
                unprocessed: task.unprocessedFiles,
              })}
            </div>
          ) : null}
          {canExpandFailures ? (
            <button
              type="button"
              className="mt-1 flex items-center gap-1 text-[10px] text-destructive hover:underline"
              onClick={() => setFailuresOpen((open) => !open)}
            >
              <HugeiconsIcon
                icon={failuresOpen ? ArrowDown01Icon : ArrowRight01Icon}
                size={10}
                strokeWidth={1.8}
              />
              {t("transfers.failedFiles", { count: fileFailures.length })}
            </button>
          ) : null}
          {canExpandFailures && failuresOpen ? (
            <div className="mt-1.5 space-y-1.5 border-l border-destructive/30 pl-2">
              {fileFailures.map((failure) => (
                <div key={failure.id} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <Hint content={failure.destinationPath}>
                      <div className="truncate text-[10px] text-foreground">
                        {basename(failure.destinationPath)}
                      </div>
                    </Hint>
                    <Hint content={failure.failure.detail}>
                      <div className="line-clamp-2 text-[9.5px] leading-3.5 text-muted-foreground">
                        {formatTransferFailure(failure.failure, t)}
                      </div>
                    </Hint>
                  </div>
                  <div className="flex shrink-0 gap-0.5">
                    <TaskButton
                      label={t("transfers.retryFile")}
                      icon={Refresh01Icon}
                      disabled={failureActionPending}
                      onClick={() =>
                        runFailureAction(() =>
                          transferNative.retryFailure(task.id, failure.id),
                        )
                      }
                    />
                    <TaskButton
                      label={t("transfers.removeFailure")}
                      icon={Delete02Icon}
                      disabled={failureActionPending}
                      onClick={() =>
                        runFailureAction(() =>
                          transferNative.ignoreFailure(task.id, failure.id),
                        )
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {active ||
          task.status === "completed" ||
          task.status === "completed_with_errors" ? (
            <Progress value={progress} className="mt-2 h-1" />
          ) : null}
          <div className="mt-1.5 flex min-h-5 items-center justify-between gap-2">
            <Hint content={task.failure?.detail}>
              <div className="min-w-0 truncate text-[10px] tabular-nums text-muted-foreground">
                {failureMessage
                  ? t("transfers.failureDetail", { error: failureMessage })
                  : task.totalBytes > 0
                    ? `${formatBytes(task.transferredBytes)} / ${formatBytes(task.totalBytes)}`
                    : t("transfers.filesProgress", {
                        completed: task.completedFiles,
                        total: task.totalFiles,
                        count: task.totalFiles,
                      })}
                {active && task.speedBytesPerSecond > 0
                  ? ` · ${formatBytes(task.speedBytesPerSecond)}/s`
                  : ""}
              </div>
            </Hint>
            <div className="flex shrink-0 items-center gap-0.5">
              {task.status === "paused" ? (
                <TaskButton
                  label={t("transfers.resume")}
                  icon={PlayIcon}
                  onClick={() => run(transferNative.resume(task.id))}
                />
              ) : task.status === "queued" || task.status === "running" ? (
                <TaskButton
                  label={t("transfers.pause")}
                  icon={PauseIcon}
                  onClick={() => run(transferNative.pause(task.id))}
                />
              ) : null}
              {active ? (
                <TaskButton
                  label={t("transfers.cancel")}
                  icon={Cancel01Icon}
                  onClick={() => run(transferNative.cancel(task.id))}
                />
              ) : (
                <>
                  {(task.status === "canceled" ||
                    task.failure?.retryable === true) && (
                    <TaskButton
                      label={t("transfers.retry")}
                      icon={Refresh01Icon}
                      onClick={() =>
                        run(transferNative.retry(task.id).then(() => undefined))
                      }
                    />
                  )}
                  <TaskButton
                    label={t("transfers.remove")}
                    icon={Delete02Icon}
                    onClick={remove}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 要求用户对当前唯一冲突做出显式决定，关闭动作不会绕过决策。 */
export function TransferConflictDialog({
  taskId,
  conflict,
}: {
  taskId: string;
  conflict: TransferConflict;
}) {
  const { t } = useTranslation("statusbar");
  const [applyToRemaining, setApplyToRemaining] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const archiveDirectory = conflict.kind === "archive_directory";
  const archiveActionClassName = archiveDirectory
    ? "h-auto min-h-9 w-full whitespace-normal py-2 text-center leading-tight"
    : undefined;

  const submit = (decision: TransferConflictDecision) => {
    setSubmitting(true);
    void transferNative
      .resolveConflict({
        taskId,
        conflictId: conflict.id,
        decision,
        applyToRemaining:
          decision !== "cancel" &&
          conflict.allowApplyToRemaining &&
          applyToRemaining,
      })
      .catch((error) => {
        setSubmitting(false);
        toast.error(
          t("transfers.operationFailed", {
            error: formatTransferError(error, t),
          }),
        );
      });
  };

  return (
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(`transfers.conflict.${conflict.kind}.title`)}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(`transfers.conflict.${conflict.kind}.description`)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 rounded-md bg-muted/50 p-2.5 text-xs">
          <div>
            <div className="text-muted-foreground">
              {t("transfers.conflict.source")}
            </div>
            <Hint content={conflict.sourcePath}>
              <div className="break-all">{conflict.sourcePath}</div>
            </Hint>
          </div>
          <div>
            <div className="text-muted-foreground">
              {t("transfers.conflict.destination")}
            </div>
            <Hint content={conflict.destinationPath}>
              <div className="break-all">{conflict.destinationPath}</div>
            </Hint>
          </div>
        </div>
        {conflict.allowApplyToRemaining ? (
          <label
            htmlFor="transfer-conflict-apply"
            className="flex items-center gap-2 text-sm"
          >
            <Checkbox
              id="transfer-conflict-apply"
              checked={applyToRemaining}
              onCheckedChange={(checked) =>
                setApplyToRemaining(checked === true)
              }
              disabled={submitting}
            />
            {t("transfers.conflict.applyToRemaining")}
          </label>
        ) : null}
        <AlertDialogFooter
          className={
            archiveDirectory
              ? "grid grid-cols-2 gap-2 sm:grid sm:grid-cols-2"
              : undefined
          }
        >
          {conflict.decisions.map((decision) =>
            decision === "cancel" ? (
              <AlertDialogCancel
                key={decision}
                className={archiveActionClassName}
                disabled={submitting}
                onClick={() => submit(decision)}
              >
                {t(`transfers.conflict.actions.${decision}`)}
              </AlertDialogCancel>
            ) : (
              <AlertDialogAction
                key={decision}
                variant={conflictActionVariant(decision)}
                className={archiveActionClassName}
                disabled={submitting}
                onClick={() => submit(decision)}
              >
                {t(`transfers.conflict.actions.${decision}`)}
              </AlertDialogAction>
            ),
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** 按冲突动作的风险和推荐程度选择稳定的按钮底色。 */
function conflictActionVariant(
  decision: TransferConflictDecision,
): "default" | "outline" | "secondary" | "destructive" {
  switch (decision) {
    case "replace":
    case "replace_directory":
      return "destructive";
    case "merge":
      return "secondary";
    case "skip":
      return "default";
    default:
      return "default";
  }
}

function TaskButton({
  label,
  icon,
  onClick,
  disabled = false,
}: {
  label: string;
  icon: typeof PauseIcon;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Hint content={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
      >
        <HugeiconsIcon icon={icon} size={11} strokeWidth={1.9} />
      </Button>
    </Hint>
  );
}

/** 将字节进度限制为进度条可接受的百分比。 */
export function transferProgress(task: TransferTask): number {
  if (task.status === "completed" || task.status === "completed_with_errors")
    return 100;
  if (task.totalBytes <= 0) return 0;
  return Math.max(
    0,
    Math.min(100, (task.transferredBytes / task.totalBytes) * 100),
  );
}

/** 将非负字节数格式化为紧凑的二进制单位文本。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function basename(path: string): string {
  const parts = path.trimEnd().split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function taskStateLabel(task: TransferTask, t: TFunction<"statusbar">): string {
  if (task.status === "failed") return t("transfers.status.failed");
  if (task.status === "canceled") return t("transfers.status.canceled");
  if (task.status === "completed") return t("transfers.status.completed");
  if (task.status === "completed_with_errors")
    return t("transfers.status.completedWithErrors");
  if (task.status === "paused") return t("transfers.status.paused");
  if (task.status === "canceling") return t("transfers.status.canceling");
  return t(`transfers.stage.${task.stage}`);
}

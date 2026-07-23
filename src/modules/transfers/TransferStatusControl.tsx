/**
 * 本文件实现状态栏文件传输概览和非模态任务面板。
 * 面板关闭不会影响 Rust 后台任务，进度只订阅独立 Zustand slice，不触发 Workbench 重渲染。
 */

import { Button } from "@/components/ui/button";
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
  Cancel01Icon,
  Delete02Icon,
  Download01Icon,
  PauseIcon,
  PlayIcon,
  Upload01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { TFunction } from "i18next";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { transferNative } from "./native";
import { useTransferBridge, useTransferStore } from "./store";
import { isActiveTransfer, type TransferTask } from "./types";

/** 展示当前进程传输任务的聚合状态和行内控制。 */
export function TransferStatusControl() {
  const environmentKind = useWorkspaceEnvStore((state) => state.env.kind);
  if (environmentKind === "local") return null;
  return <TransferStatusPanel />;
}

/** 仅在非本地 Workspace 挂载任务订阅和面板状态。 */
function TransferStatusPanel() {
  const { t } = useTranslation("statusbar");
  const taskMap = useTransferStore((state) => state.tasks);
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
  const failed = tasks.filter((task) => task.status === "failed").length;
  const totalBytes = active.reduce((sum, task) => sum + task.totalBytes, 0);
  const transferredBytes = active.reduce(
    (sum, task) => sum + Math.min(task.transferredBytes, task.totalBytes),
    0,
  );
  const progress = totalBytes > 0 ? (transferredBytes / totalBytes) * 100 : 0;
  const showAggregateProgress =
    totalBytes > 0 &&
    active.every(
      (task) => task.stage !== "queued" && task.stage !== "scanning",
    );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-6 items-center gap-1 rounded-sm px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground",
            failed > 0 && "text-destructive",
          )}
          title={t("transfers.title")}
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
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="w-[430px] max-w-[calc(100vw-16px)] gap-0 overflow-hidden rounded-xl p-0"
      >
        <div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
          <div>
            <div className="text-sm font-medium">{t("transfers.title")}</div>
            <div className="text-[11px] text-muted-foreground">
              {active.length > 0
                ? t("transfers.runningCount", { count: active.length })
                : t("transfers.noActive")}
            </div>
          </div>
          {showAggregateProgress ? (
            <div className="text-xs tabular-nums text-muted-foreground">
              {Math.round(progress)}%
            </div>
          ) : null}
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
    </Popover>
  );
}

function TransferTaskRow({ task }: { task: TransferTask }) {
  const { t } = useTranslation("statusbar");
  const removeLocal = useTransferStore((state) => state.removeLocal);
  const active = isActiveTransfer(task);
  const progress = transferProgress(task);
  const detail = task.currentFile
    ? basename(task.currentFile)
    : task.destination;
  const displayName =
    task.sourceCount > 1
      ? t("transfers.items", { count: task.sourceCount })
      : task.name;

  const run = (operation: Promise<void>) => {
    void operation.catch((error) =>
      toast.error(t("transfers.operationFailed", { error: String(error) })),
    );
  };
  const remove = () => {
    void transferNative
      .remove(task.id)
      .then(() => removeLocal(task.id))
      .catch((error) =>
        toast.error(t("transfers.operationFailed", { error: String(error) })),
      );
  };

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
            task.status === "failed" && "bg-destructive/10 text-destructive",
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
                task.status === "failed" && "text-destructive",
              )}
            >
              {taskStateLabel(task, t)}
            </span>
          </div>
          <div
            className="mt-0.5 truncate text-[10.5px] text-muted-foreground"
            title={detail}
          >
            {detail}
          </div>
          {active || task.status === "completed" ? (
            <Progress value={progress} className="mt-2 h-1" />
          ) : null}
          <div className="mt-1.5 flex min-h-5 items-center justify-between gap-2">
            <div
              className="min-w-0 truncate text-[10px] tabular-nums text-muted-foreground"
              title={task.error ?? undefined}
            >
              {task.error
                ? t("transfers.failureDetail", { error: task.error })
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
                <TaskButton
                  label={t("transfers.remove")}
                  icon={Delete02Icon}
                  onClick={remove}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TaskButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: typeof PauseIcon;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="text-muted-foreground"
    >
      <HugeiconsIcon icon={icon} size={11} strokeWidth={1.9} />
    </Button>
  );
}

/** 将字节进度限制为进度条可接受的百分比。 */
export function transferProgress(task: TransferTask): number {
  if (task.status === "completed") return 100;
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
  if (task.status === "paused") return t("transfers.status.paused");
  if (task.status === "canceling") return t("transfers.status.canceling");
  return t(`transfers.stage.${task.stage}`);
}

/** SSH 传输行的时间摘要。运行耗时来自原生快照，剩余时间仅采样当前连续传输阶段。 */
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Hint } from "@/components/controls/tooltip";
import { isActiveTransfer, type TransferTask } from "@/modules/transfers/types";

function duration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const mm = String(minutes % 60).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return minutes < 60
    ? `${mm}:${ss}`
    : `${Math.floor(minutes / 60)}:${mm}:${ss}`;
}

/** 状态或阶段切换时由任务行重新挂载，避免续传沿用暂停前的速度样本。 */
export function TransferTiming({ task }: { task: TransferTask }) {
  const { t } = useTranslation("statusbar");
  const [now, setNow] = useState(Date.now);
  const [remaining, setRemaining] = useState<number | null>(null);
  const running = task.status === "running";
  const transferring =
    running &&
    task.stage === "transferring" &&
    task.totalBytes > task.transferredBytes;
  const readProgress = useEffectEvent(() => ({
    bytes: task.transferredBytes,
    total: task.totalBytes,
  }));
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!transferring) return;
    const samples = [{ at: performance.now(), bytes: readProgress().bytes }];
    const timer = window.setInterval(() => {
      const at = performance.now();
      const { bytes, total } = readProgress();
      const previous = samples[samples.length - 1];
      samples.push({ at, bytes });
      while (at - samples[0].at > 15_000) samples.shift();
      const first = samples[0];
      // 短暂停滞时保留已显示的估值，直到有新的字节进度可供替换。
      if (bytes <= previous.bytes || bytes <= first.bytes || bytes >= total)
        return;
      const seconds =
        ((total - bytes) * (at - first.at)) / (bytes - first.bytes) / 1000;
      const step = seconds >= 3600 ? 60 : seconds >= 60 ? 10 : 1;
      setRemaining(Math.ceil(seconds / step) * step);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [transferring]);

  const elapsed =
    task.elapsedMs === null
      ? null
      : Math.floor(
          (task.elapsedMs + (running ? Math.max(0, now - task.updatedAt) : 0)) /
            1000,
        );
  const time = { duration: duration(elapsed ?? 0) };
  return (
    <>
      {(task.status === "paused" || transferring) && (
        <span
          data-slot="transfer-estimate"
          className="min-w-[10em] text-right tabular-nums text-muted-foreground"
        >
          {task.status === "paused"
            ? t("transfers.status.paused")
            : remaining !== null
              ? t("transfers.timing.remaining", {
                  duration: duration(remaining),
                })
              : null}
        </span>
      )}
      {elapsed !== null && (
        <span className="inline-grid text-right tabular-nums text-muted-foreground">
          {/* 两种耗时文案共用自然宽度，状态切换时保持左侧状态栏的右边界。 */}
          <span
            aria-hidden="true"
            className="invisible col-start-1 row-start-1"
          >
            {t(
              isActiveTransfer(task)
                ? "transfers.timing.total"
                : "transfers.timing.elapsed",
              time,
            )}
          </span>
          <span
            data-slot="transfer-elapsed"
            className="col-start-1 row-start-1"
          >
            {t(
              isActiveTransfer(task)
                ? "transfers.timing.elapsed"
                : "transfers.timing.total",
              time,
            )}
          </span>
        </span>
      )}
    </>
  );
}

export function TransferCreatedAt({ createdAt }: { createdAt: number }) {
  const { t, i18n } = useTranslation("statusbar");
  const created = useMemo(() => new Date(createdAt), [createdAt]);
  const today = new Date();
  const sameDay = created.toDateString() === today.toDateString();
  const sameYear = created.getFullYear() === today.getFullYear();
  const language = i18n.language;
  const stamp = useMemo(
    () => ({
      date: sameDay
        ? t("transfers.timing.today")
        : created.toLocaleDateString(language, {
            year: sameYear ? undefined : "numeric",
            month: "short",
            day: "numeric",
          }),
      time: created.toLocaleTimeString(language, {
        hour: "2-digit",
        minute: "2-digit",
      }),
      full: created.toLocaleString(language, {
        dateStyle: "full",
        timeStyle: "medium",
      }),
    }),
    [created, language, sameDay, sameYear, t],
  );
  return (
    <Hint content={stamp.full}>
      <time
        className="mr-1 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground"
        dateTime={created.toISOString()}
      >
        {t("transfers.timing.created", stamp)}
      </time>
    </Hint>
  );
}

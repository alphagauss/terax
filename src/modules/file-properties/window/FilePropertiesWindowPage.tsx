/**
 * 本文件实现文件属性辅助窗口页面。
 * 页面先展示目标自身的快速快照，再异步执行可取消的目录统计，不持有 Workspace 运行时。
 */

import { Hint } from "@/components/controls/tooltip";
import { AuxiliaryWindowLayout } from "@/auxiliary/AuxiliaryWindowLayout";
import { useAuxiliaryOpenRequest } from "@/auxiliary/useAuxiliaryOpenRequest";
import { Button } from "@/components/controls/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { formatBytes, formatPosixMode } from "@/modules/file-properties/format";
import {
  cancelDirectoryPropertiesScan,
  type DirectorySummary,
  type FilePropertiesSnapshot,
  getFileProperties,
  type PropertyKind,
  scanDirectoryProperties,
} from "@/modules/file-properties/native";
import {
  Copy01Icon,
  File02Icon,
  Folder01Icon,
  Refresh01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

type ScanState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; summary: DirectorySummary }
  | { status: "cancelled" }
  | { status: "error"; message: string };

function kindIcon(kind: PropertyKind) {
  return kind === "directory" ? Folder01Icon : File02Icon;
}

function PropertyRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[108px_minmax(0,1fr)] gap-3 py-1 text-[12px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn("min-w-0 break-words", mono && "font-mono text-[11.5px]")}
      >
        {value}
      </dd>
    </div>
  );
}

/** 渲染只读文件属性页，并在目标切换或窗口关闭时取消旧目录统计。 */
export function FilePropertiesWindowPage() {
  const { t, i18n } = useTranslation("fileProperties");
  const envelope = useAuxiliaryOpenRequest();
  const request = envelope?.request;
  const target = request?.kind === "file-properties" ? request.path : null;
  const [snapshot, setSnapshot] = useState<FilePropertiesSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanState>({ status: "idle" });
  const [pathCopied, setPathCopied] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const activeScanRef = useRef<string | null>(null);
  const copyFeedbackTimeoutRef = useRef<number>(0);
  const loadTarget = target ? `${target}\0${refreshVersion}` : null;

  useEffect(() => {
    const nativeWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void nativeWindow
      .onCloseRequested((event) => {
        const scanId = activeScanRef.current;
        if (!scanId) return;
        event.preventDefault();
        activeScanRef.current = null;
        void cancelDirectoryPropertiesScan(scanId)
          .catch((error) =>
            console.error("关闭属性窗口前取消目录统计失败", error),
          )
          .finally(() => {
            if (disposed) return;
            void nativeWindow
              .destroy()
              .catch((error) => console.error("销毁文件属性窗口失败", error));
          });
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(
    () => () => window.clearTimeout(copyFeedbackTimeoutRef.current),
    [],
  );

  useEffect(() => {
    if (!target || !loadTarget) return;
    let active = true;
    setLoading(true);
    setError(null);
    setSnapshot(null);
    setScan({ status: "idle" });
    window.clearTimeout(copyFeedbackTimeoutRef.current);
    setPathCopied(false);

    void (async () => {
      try {
        const next = await getFileProperties(target);
        if (!active) return;
        setSnapshot(next);
        setLoading(false);
        if (next.kind !== "directory") return;

        const scanId = crypto.randomUUID();
        activeScanRef.current = scanId;
        setScan({ status: "loading" });
        try {
          const summary = await scanDirectoryProperties(target, scanId);
          if (active && activeScanRef.current === scanId) {
            activeScanRef.current = null;
            setScan({ status: "ready", summary });
          }
        } catch (scanError) {
          if (active && activeScanRef.current === scanId) {
            activeScanRef.current = null;
            setScan({ status: "error", message: String(scanError) });
          }
        }
      } catch (loadError) {
        if (!active) return;
        setLoading(false);
        setError(String(loadError));
      }
    })();

    return () => {
      active = false;
      const scanId = activeScanRef.current;
      activeScanRef.current = null;
      if (scanId) void cancelDirectoryPropertiesScan(scanId).catch(() => {});
    };
  }, [target, loadTarget]);

  const cancelScan = () => {
    const scanId = activeScanRef.current;
    if (!scanId) return;
    activeScanRef.current = null;
    setScan({ status: "cancelled" });
    void cancelDirectoryPropertiesScan(scanId).catch(() => {});
  };

  /** 启动一次刷新，并立即锁定入口以避免结果返回前重复触发。 */
  const refreshProperties = () => {
    if (!target || loading || scan.status === "loading") return;
    setLoading(true);
    setRefreshVersion((value) => value + 1);
  };

  /** 将完整路径写入系统剪贴板，并短暂显示复制成功状态。 */
  const copyPath = async () => {
    if (!target || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(target);
      window.clearTimeout(copyFeedbackTimeoutRef.current);
      setPathCopied(true);
      copyFeedbackTimeoutRef.current = window.setTimeout(
        () => setPathCopied(false),
        3000,
      );
    } catch {
      // 与 Markdown 代码块一致，剪贴板拒绝时保持原状态。
    }
  };

  const formatDate = (value: number | null) =>
    value === null
      ? t("unavailable")
      : new Intl.DateTimeFormat(i18n.language, {
          dateStyle: "medium",
          timeStyle: "medium",
        }).format(new Date(value));

  const snapshotMatchesTarget = snapshot?.path === target;
  const title = snapshotMatchesTarget
    ? t("windowTitle", { name: snapshot.name })
    : t("title");

  return (
    <AuxiliaryWindowLayout
      title={title}
      headerContent={
        <div
          data-tauri-drag-region
          className="flex min-w-0 flex-1 items-center gap-1"
        >
          <span
            data-tauri-drag-region
            className="min-w-0 flex-1 truncate text-[12px] font-medium"
          >
            {title}
          </span>
          <Hint content={t("common:refresh")}>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              disabled={!target || loading || scan.status === "loading"}
              onClick={refreshProperties}
              aria-label={t("common:refresh")}
            >
              <HugeiconsIcon
                icon={Refresh01Icon}
                size={13}
                strokeWidth={1.75}
              />
            </Button>
          </Hint>
        </div>
      }
    >
      <main className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-2">
        {!target || loading || (!error && !snapshotMatchesTarget) ? (
          <div className="flex h-full min-h-64 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-4 motion-reduce:animate-none" />
            {t("loading")}
          </div>
        ) : error ? (
          <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 text-center">
            <div className="text-sm font-medium">{t("loadFailed")}</div>
            <div className="max-w-sm break-words text-xs text-muted-foreground">
              {error}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRefreshVersion((value) => value + 1)}
            >
              {t("retry")}
            </Button>
          </div>
        ) : snapshotMatchesTarget && snapshot ? (
          <div className="mx-auto flex w-full max-w-xl flex-col gap-3.5">
            <section className="flex min-w-0 items-center gap-2.5 border-b border-border/60 pb-2.5">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <HugeiconsIcon
                  icon={kindIcon(snapshot.kind)}
                  size={21}
                  strokeWidth={1.5}
                />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-[15px] font-semibold">
                  {snapshot.name}
                </h1>
                <div className="mt-0.5 flex min-w-0 items-start gap-1">
                  <p className="min-w-0 flex-1 break-all font-mono text-[10.5px] text-muted-foreground select-text">
                    {snapshot.path}
                  </p>
                  <Hint
                    content={pathCopied ? t("common:copied") : t("common:copy")}
                  >
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => void copyPath()}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label={
                        pathCopied ? t("common:copied") : t("common:copy")
                      }
                    >
                      <HugeiconsIcon
                        icon={pathCopied ? Tick02Icon : Copy01Icon}
                        size={11}
                        strokeWidth={1.75}
                      />
                    </Button>
                  </Hint>
                </div>
              </div>
            </section>

            <section>
              <h2 className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {t("general")}
              </h2>
              <dl>
                <PropertyRow
                  label={t("type")}
                  value={t(`kinds.${snapshot.kind}`)}
                />
                {snapshot.kind !== "directory" ? (
                  <PropertyRow
                    label={t("size")}
                    value={formatBytes(
                      snapshot.logicalSizeBytes,
                      i18n.language,
                    )}
                  />
                ) : null}
                {snapshot.allocatedSizeBytes !== null &&
                snapshot.kind !== "directory" ? (
                  <PropertyRow
                    label={t("allocatedSize")}
                    value={formatBytes(
                      snapshot.allocatedSizeBytes,
                      i18n.language,
                    )}
                  />
                ) : null}
              </dl>
            </section>

            {snapshot.kind === "directory" ? (
              <section>
                <div className="mb-1 flex items-center justify-between gap-3">
                  <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    {t("contents")}
                  </h2>
                  {scan.status === "loading" ? (
                    <Button variant="ghost" size="xs" onClick={cancelScan}>
                      {t("stop")}
                    </Button>
                  ) : scan.status === "cancelled" || scan.status === "error" ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setRefreshVersion((value) => value + 1)}
                    >
                      {t("recalculate")}
                    </Button>
                  ) : null}
                </div>
                {scan.status === "loading" ? (
                  <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/50 px-3 py-2 text-xs text-muted-foreground">
                    <Spinner className="size-3.5 motion-reduce:animate-none" />
                    {t("calculating")}
                  </div>
                ) : scan.status === "ready" ? (
                  <dl>
                    <PropertyRow
                      label={t("files")}
                      value={new Intl.NumberFormat(i18n.language).format(
                        scan.summary.files,
                      )}
                    />
                    <PropertyRow
                      label={t("folders")}
                      value={new Intl.NumberFormat(i18n.language).format(
                        scan.summary.directories,
                      )}
                    />
                    {scan.summary.symlinks > 0 ? (
                      <PropertyRow
                        label={t("symlinks")}
                        value={new Intl.NumberFormat(i18n.language).format(
                          scan.summary.symlinks,
                        )}
                      />
                    ) : null}
                    <PropertyRow
                      label={t("size")}
                      value={formatBytes(
                        scan.summary.logicalSizeBytes,
                        i18n.language,
                      )}
                    />
                    {scan.summary.allocatedSizeBytes !== null ? (
                      <PropertyRow
                        label={t("allocatedSize")}
                        value={formatBytes(
                          scan.summary.allocatedSizeBytes,
                          i18n.language,
                        )}
                      />
                    ) : null}
                    {!scan.summary.complete ? (
                      <PropertyRow
                        label={t("scanStatus")}
                        value={t("partial", {
                          count: scan.summary.unreadableEntries,
                        })}
                      />
                    ) : null}
                  </dl>
                ) : scan.status === "cancelled" ? (
                  <p className="text-xs text-muted-foreground">
                    {t("cancelled")}
                  </p>
                ) : scan.status === "error" ? (
                  <p className="break-words text-xs text-destructive">
                    {t("scanFailed", { error: scan.message })}
                  </p>
                ) : null}
              </section>
            ) : null}

            <section>
              <h2 className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {t("timestamps")}
              </h2>
              <dl>
                <PropertyRow
                  label={t("modifiedAt")}
                  value={formatDate(snapshot.modifiedAt)}
                />
                {snapshot.createdAt !== null ? (
                  <PropertyRow
                    label={t("createdAt")}
                    value={formatDate(snapshot.createdAt)}
                  />
                ) : null}
                {snapshot.accessedAt !== null ? (
                  <PropertyRow
                    label={t("accessedAt")}
                    value={formatDate(snapshot.accessedAt)}
                  />
                ) : null}
                {snapshot.changedAt !== null ? (
                  <PropertyRow
                    label={t("changedAt")}
                    value={formatDate(snapshot.changedAt)}
                  />
                ) : null}
              </dl>
            </section>

            <section>
              <h2 className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {t("access")}
              </h2>
              <dl>
                {snapshot.access.kind === "posix" ? (
                  <>
                    <PropertyRow
                      label={t("permissions")}
                      value={formatPosixMode(snapshot.access.mode)}
                      mono
                    />
                    <PropertyRow
                      label={t("owner")}
                      value={
                        snapshot.access.ownerName ??
                        snapshot.access.uid ??
                        t("unavailable")
                      }
                    />
                    <PropertyRow
                      label={t("group")}
                      value={
                        snapshot.access.groupName ??
                        snapshot.access.gid ??
                        t("unavailable")
                      }
                    />
                  </>
                ) : snapshot.access.kind === "windows" ? (
                  <>
                    <PropertyRow
                      label={t("readOnly")}
                      value={snapshot.access.readOnly ? t("yes") : t("no")}
                    />
                    {snapshot.access.ownerName ? (
                      <PropertyRow
                        label={t("owner")}
                        value={snapshot.access.ownerName}
                      />
                    ) : null}
                  </>
                ) : (
                  <PropertyRow
                    label={t("permissions")}
                    value={t("unavailable")}
                  />
                )}
              </dl>
            </section>
          </div>
        ) : null}
      </main>
    </AuxiliaryWindowLayout>
  );
}

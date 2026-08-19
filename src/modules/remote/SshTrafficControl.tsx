/**
 * 本文件实现状态栏中的进程级 SSH 流量控件。
 * 前端仅在 Workspace WebView 可见时低频读取累计值，速率由相邻快照计算，统计本身始终由 Rust 持有。
 */

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { ArrowDown02Icon, ArrowUp02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { remoteNative } from "./native";
import type { SshTrafficSnapshot } from "./types";

const SAMPLE_INTERVAL_MS = 1_000;
const TRAFFIC_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
const ZERO_TRAFFIC: SshTrafficSnapshot = {
  uploadedBytes: 0,
  downloadedBytes: 0,
};

type TrafficDisplay = SshTrafficSnapshot & {
  uploadRate: number;
  downloadRate: number;
};

type TimedSnapshot = {
  traffic: SshTrafficSnapshot;
  sampledAt: number;
};

/** 根据两个单调累计值计算采样区间内的每秒速率。 */
export function calculateSshTrafficRate(
  previousBytes: number,
  currentBytes: number,
  elapsedMs: number,
): number {
  if (
    !Number.isFinite(previousBytes) ||
    !Number.isFinite(currentBytes) ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0
  ) {
    return 0;
  }
  return (Math.max(0, currentBytes - previousBytes) * 1_000) / elapsedMs;
}

/** 将字节数格式化为自动切换单位的紧凑文本。 */
export function formatSshTrafficBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const index = Math.max(
    0,
    Math.min(TRAFFIC_UNITS.length - 1, Math.floor(Math.log2(bytes) / 10)),
  );
  const value = bytes / 1_024 ** index;
  const digits = index === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${TRAFFIC_UNITS[index]}`;
}

/** 将每秒速率格式化为固定展示宽度内的紧凑文本。 */
export function formatSshTrafficRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 KB/s";
  if (bytesPerSecond < 1_024) return "<1 KB/s";
  let index = Math.max(
    1,
    Math.min(
      TRAFFIC_UNITS.length - 1,
      Math.floor(Math.log2(bytesPerSecond) / 10),
    ),
  );
  let value = bytesPerSecond / 1_024 ** index;
  if (value >= 1_000 && index < TRAFFIC_UNITS.length - 1) {
    index += 1;
    value = bytesPerSecond / 1_024 ** index;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${TRAFFIC_UNITS[index]}/s`;
}

/** 读取当前进程累计流量，并在相邻可见采样之间计算平均速率。 */
function useSshTraffic(): TrafficDisplay {
  const [display, setDisplay] = useState<TrafficDisplay>({
    ...ZERO_TRAFFIC,
    uploadRate: 0,
    downloadRate: 0,
  });

  useEffect(() => {
    let active = true;
    let running = false;
    let timer: number | null = null;
    let revision = 0;
    let previous: TimedSnapshot | null = null;

    const clearTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };

    const setIdleRate = () => {
      setDisplay((current) =>
        current.uploadRate === 0 && current.downloadRate === 0
          ? current
          : { ...current, uploadRate: 0, downloadRate: 0 },
      );
    };

    const schedule = () => {
      clearTimer();
      if (!active || document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => {
        timer = null;
        void refresh();
      }, SAMPLE_INTERVAL_MS);
    };

    const refresh = async () => {
      if (!active || running || document.visibilityState !== "visible") {
        return;
      }
      running = true;
      const requestRevision = ++revision;
      try {
        const traffic = await remoteNative.trafficSnapshot();
        const sampledAt = performance.now();
        if (
          !active ||
          requestRevision !== revision ||
          document.visibilityState !== "visible"
        ) {
          return;
        }
        const elapsedMs = previous ? sampledAt - previous.sampledAt : 0;
        const next: TrafficDisplay = {
          ...traffic,
          uploadRate: previous
            ? calculateSshTrafficRate(
                previous.traffic.uploadedBytes,
                traffic.uploadedBytes,
                elapsedMs,
              )
            : 0,
          downloadRate: previous
            ? calculateSshTrafficRate(
                previous.traffic.downloadedBytes,
                traffic.downloadedBytes,
                elapsedMs,
              )
            : 0,
        };
        setDisplay((current) =>
          current.uploadedBytes === next.uploadedBytes &&
          current.downloadedBytes === next.downloadedBytes &&
          current.uploadRate === next.uploadRate &&
          current.downloadRate === next.downloadRate
            ? current
            : next,
        );
        previous = { traffic, sampledAt };
      } catch {
        if (!active || requestRevision !== revision) return;
        previous = null;
        setIdleRate();
      } finally {
        running = false;
        if (
          active &&
          requestRevision !== revision &&
          document.visibilityState === "visible"
        ) {
          void refresh();
        } else {
          schedule();
        }
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        revision += 1;
        previous = null;
        clearTimer();
        setIdleRate();
        return;
      }
      void refresh();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    void refresh();
    return () => {
      active = false;
      revision += 1;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return display;
}

/** 在 SSH Workspace 状态栏常驻显示双向速率，并提供当前进程累计流量。 */
export function SshTrafficControl() {
  const isSsh = useWorkspaceEnvStore((state) => state.env.kind === "ssh");
  if (!isSsh) return null;
  return <SshTrafficPanel />;
}

/** 保持采样 Hook 只在 SSH Workspace 中挂载。 */
function SshTrafficPanel() {
  const { t } = useTranslation("statusbar");
  const traffic = useSshTraffic();
  const uploadRate = formatSshTrafficRate(traffic.uploadRate);
  const downloadRate = formatSshTrafficRate(traffic.downloadRate);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-6 items-center gap-1.5 rounded-sm px-1 text-[11px] tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("sshTraffic.label")}
          aria-label={t("sshTraffic.label")}
        >
          <span className="grid grid-cols-[11px_54px] items-center gap-0.5 whitespace-nowrap">
            <HugeiconsIcon icon={ArrowUp02Icon} size={11} strokeWidth={1.8} />
            <span>{uploadRate}</span>
          </span>
          <span className="grid grid-cols-[11px_54px] items-center gap-0.5 whitespace-nowrap">
            <HugeiconsIcon icon={ArrowDown02Icon} size={11} strokeWidth={1.8} />
            <span>{downloadRate}</span>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="w-72 rounded-xl p-3"
      >
        <div className="text-sm font-medium">{t("sshTraffic.title")}</div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          {t("sshTraffic.description")}
        </div>
        <div className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-xs">
          <span className="text-muted-foreground">
            {t("sshTraffic.uploaded")}
          </span>
          <span className="tabular-nums font-medium">
            {formatSshTrafficBytes(traffic.uploadedBytes)}
          </span>
          <span className="text-muted-foreground">
            {t("sshTraffic.downloaded")}
          </span>
          <span className="tabular-nums font-medium">
            {formatSshTrafficBytes(traffic.downloadedBytes)}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

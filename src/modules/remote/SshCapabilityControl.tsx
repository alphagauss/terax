/**
 * 本文件实现 SSH Workspace 状态栏能力灯和服务器命令详情弹层。
 * 快照严格绑定连接 epoch；自动探测不阻塞 Workspace，用户可以显式重新检测当前连接。
 */

import { Hint } from "@/components/controls/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { remoteNative } from "./native";
import { useRemoteRuntimeStore } from "./runtimeStore";
import type { SshCapabilitySnapshot, SshCapabilityState } from "./types";

const EMPTY_CAPABILITIES: SshCapabilitySnapshot = {
  epoch: null,
  state: "unknown",
  checkedAt: null,
  commands: [],
  features: [],
};

const lampClass: Record<SshCapabilityState, string> = {
  unknown: "bg-muted-foreground/45",
  checking: "bg-muted-foreground/45 animate-pulse",
  ready: "bg-success",
  fallback: "bg-warning",
  unavailable: "bg-destructive",
};

/** 展示当前 SSH epoch 的统一服务器能力，并允许用户在安装依赖后重新检测。 */
export function SshCapabilityControl() {
  const { t } = useTranslation("statusbar");
  const env = useWorkspaceEnvStore((state) => state.env);
  const runtime = useRemoteRuntimeStore((state) => state.snapshot);
  const epoch =
    env.kind === "ssh" &&
    runtime.phase === "connected" &&
    runtime.profileId === env.profileId
      ? runtime.epoch
      : null;
  const [snapshot, setSnapshot] = useState(EMPTY_CAPABILITIES);
  const [rechecking, setRechecking] = useState(false);

  useEffect(() => {
    if (epoch === null) {
      setSnapshot(EMPTY_CAPABILITIES);
      return;
    }
    let active = true;
    let eventSeen = false;
    let unlisten: (() => void) | undefined;
    const apply = (next: SshCapabilitySnapshot) => {
      if (active && next.epoch === epoch) setSnapshot(next);
    };
    void (async () => {
      unlisten = await remoteNative.onCapabilities((next) => {
        eventSeen = true;
        apply(next);
      });
      if (!active) {
        unlisten();
        return;
      }
      const initial = await remoteNative.capabilitiesSnapshot();
      if (!eventSeen) apply(initial);
    })().catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, [epoch]);

  const current = snapshot.epoch === epoch ? snapshot : EMPTY_CAPABILITIES;
  const counts = useMemo(
    () => ({
      ready: current.features.filter((feature) => feature.state === "ready")
        .length,
      total: current.features.length,
    }),
    [current.features],
  );
  if (epoch === null) return null;

  const recheck = async () => {
    if (rechecking) return;
    setRechecking(true);
    try {
      applySnapshot(
        setSnapshot,
        epoch,
        await remoteNative.reprobeCapabilities(),
      );
    } catch {
      // 后端会同步发布 unknown 快照；这里避免点击事件产生未处理拒绝。
    } finally {
      setRechecking(false);
    }
  };
  const label = t(`sshCapabilities.states.${current.state}`);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Hint content={t("sshCapabilities.aria", { state: label })}>
          <button
            type="button"
            className="flex h-6 w-5 items-center justify-center rounded-sm hover:bg-accent"
            aria-label={t("sshCapabilities.aria", { state: label })}
          >
            <span
              className={cn("size-2 rounded-full", lampClass[current.state])}
            />
          </button>
        </Hint>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-[22rem] rounded-xl p-0"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
          <div>
            <div className="text-sm font-medium">
              {t("sshCapabilities.title")}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {current.state === "checking" || current.state === "unknown"
                ? label
                : t("sshCapabilities.summary", counts)}
            </div>
          </div>
          <button
            type="button"
            disabled={rechecking || current.state === "checking"}
            onClick={() => void recheck()}
            className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {rechecking
              ? t("sshCapabilities.checking")
              : t("sshCapabilities.recheck")}
          </button>
        </div>

        <div className="max-h-[25rem] overflow-y-auto p-3">
          <CapabilitySection title={t("sshCapabilities.featuresTitle")}>
            {current.features.map((feature) => (
              <div
                key={feature.id}
                className="grid grid-cols-[8px_1fr_auto] items-center gap-2 py-1"
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    lampClass[feature.state],
                  )}
                />
                <span className="text-xs">
                  {t(`sshCapabilities.features.${feature.id}`)}
                </span>
                <span className="text-[10.5px] text-muted-foreground">
                  {feature.backend ?? t("sshCapabilities.notAvailable")}
                </span>
              </div>
            ))}
          </CapabilitySection>

          <CapabilitySection title={t("sshCapabilities.commandsTitle")}>
            {current.commands.map((command) => (
              <div
                key={command.id}
                className="grid grid-cols-[8px_1fr_auto] items-center gap-2 py-1"
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    command.state === "ready"
                      ? "bg-success"
                      : command.state === "missing"
                        ? "bg-destructive"
                        : "bg-warning",
                  )}
                />
                <span className="font-mono text-[11px]">{command.command}</span>
                <span className="text-[10.5px] text-muted-foreground">
                  {command.detail ??
                    t(`sshCapabilities.commandStates.${command.state}`)}
                </span>
              </div>
            ))}
          </CapabilitySection>

          {current.commands.some(
            (command) =>
              command.id === "rg_content" && command.state !== "ready",
          ) ? (
            <div className="mt-3 rounded-md bg-warning/8 px-2.5 py-2 text-[11px] leading-relaxed text-warning">
              {t("sshCapabilities.ripgrepSuggestion")}
            </div>
          ) : null}
          {current.checkedAt !== null ? (
            <div className="mt-3 text-[10.5px] text-muted-foreground">
              {t("sshCapabilities.checkedAt", {
                value: new Date(current.checkedAt).toLocaleTimeString(),
              })}
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** 只接受仍属于当前连接 epoch 的命令响应。 */
function applySnapshot(
  setSnapshot: (snapshot: SshCapabilitySnapshot) => void,
  epoch: number,
  snapshot: SshCapabilitySnapshot,
) {
  if (snapshot.epoch === epoch) setSnapshot(snapshot);
}

/** 能力详情中的紧凑分组。 */
function CapabilitySection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-3 first:mt-0">
      <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </section>
  );
}

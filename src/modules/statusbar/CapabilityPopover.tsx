/** 共享状态栏能力灯及功能、命令和重检详情。 */

import { Hint } from "@/components/controls/tooltip";
import { Button } from "@/components/controls/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type {
  CapabilityReport,
  CapabilityState,
} from "@/modules/workspace/capabilities";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

const lampClass: Record<CapabilityState, string> = {
  unknown: "bg-muted-foreground/45",
  checking: "bg-muted-foreground/45 animate-pulse",
  ready: "bg-success",
  fallback: "bg-warning",
  unavailable: "bg-destructive",
};

/** 渲染当前 Workspace 的能力结果，由调用方管理探测生命周期。 */
export function CapabilityPopover({
  kind,
  report: current,
  rechecking = false,
  onRecheck,
}: {
  kind: "ssh" | "wsl";
  report: CapabilityReport;
  rechecking?: boolean;
  onRecheck: () => void | Promise<void>;
}) {
  const { t } = useTranslation("statusbar");
  const counts = {
    ready: current.features.filter((feature) => feature.state === "ready")
      .length,
    total: current.features.length,
  };
  const titleKey = kind === "wsl" ? "wslCapabilities" : "sshCapabilities";
  const label = t(`sshCapabilities.states.${current.state}`);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Hint content={t(`${titleKey}.aria`, { state: label })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="status-bar-item"
            aria-label={t(`${titleKey}.aria`, { state: label })}
          >
            <span
              className={cn("size-1.5 rounded-full", lampClass[current.state])}
            />
          </Button>
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
            <div className="text-sm font-medium">{t(`${titleKey}.title`)}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {current.state === "checking" || current.state === "unknown"
                ? label
                : t("sshCapabilities.summary", counts)}
            </div>
          </div>
          <button
            type="button"
            disabled={rechecking || current.state === "checking"}
            onClick={() => void onRecheck()}
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
                  {kind === "wsl" && feature.id === "explorer_paste"
                    ? t("wslCapabilities.nativePaste")
                    : t(`sshCapabilities.features.${feature.id}`)}
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

          {kind === "ssh" &&
          current.commands.some(
            (command) =>
              command.id === "rg_content" && command.state !== "ready",
          ) ? (
            <div className="mt-3 rounded-md bg-warning/8 px-2.5 py-2 text-[11px] leading-relaxed text-warning">
              {t("sshCapabilities.ripgrepSuggestion")}
            </div>
          ) : null}
          {kind === "wsl" ? (
            <div className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              {current.state === "unknown" && (
                <p className="mb-1">{t("wslCapabilities.probeFailed")}</p>
              )}
              {t("wslCapabilities.hostMounts")}
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

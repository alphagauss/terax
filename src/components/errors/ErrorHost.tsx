/**
 * 所有窗口共用的错误浮层，提供阅读暂停、详情复制和当前窗口的最近错误。
 * 弹窗打开时把同一个展示节点移入其焦点范围，避免仅提高层级却无法操作。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/controls/button";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { writeClipboardText } from "@/lib/clipboard";
import {
  copyableError,
  clearErrors,
  dismissError,
  elapseErrors,
  errorStore,
  setErrorHistoryOpen,
  type ErrorReport,
} from "@/lib/errors";

function ErrorCard({
  report,
  historical,
  pause,
}: {
  report: ErrorReport;
  historical: boolean;
  pause: (id: string, paused: boolean) => void;
}) {
  const { t } = useTranslation("common");
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [copyState, setCopyState] = useState<"copy" | "copied" | "copyFailed">(
    "copy",
  );
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copying = useRef(false);
  useEffect(() => {
    pause(report.id, expanded || hovered || focused || historical);
    return () => pause(report.id, false);
  }, [report.id, expanded, hovered, focused, historical, pause]);
  useEffect(
    () => () => {
      copying.current = false;
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copy = async () => {
    if (copying.current) return;
    copying.current = true;
    let result: typeof copyState;
    try {
      await writeClipboardText(copyableError(report));
      result = "copied";
    } catch {
      result = "copyFailed";
    }
    // 关闭或清空后，不再为已卸载的卡片创建反馈定时器。
    if (!copying.current) return;
    copying.current = false;
    setCopyState(result);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyState("copy"), 2500);
  };

  return (
    <section
      aria-label={report.title}
      className="rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2 duration-surface"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      <div className="flex items-start gap-2">
        <HugeiconsIcon
          icon={Alert02Icon}
          size={14}
          strokeWidth={1.75}
          className="mt-0.5 shrink-0 text-destructive"
          aria-hidden="true"
        />
        <button
          type="button"
          className="min-w-0 flex-1 cursor-default select-text text-left"
          aria-label={
            historical
              ? report.title
              : t("errors.dismiss", { title: report.title })
          }
          aria-expanded={historical ? expanded : undefined}
          onClick={() => {
            if (window.getSelection()?.toString()) return;
            if (historical) setExpanded(!expanded);
            else dismissError(report.id);
          }}
        >
          <span className="block line-clamp-2 break-words font-medium">
            {report.title}
          </span>
          {report.source && (
            <span className="mt-1 block truncate text-muted-foreground">
              {report.source}
            </span>
          )}
          {!expanded && report.details && (
            <span className="mt-1 line-clamp-2 break-words text-muted-foreground">
              {report.details}
            </span>
          )}
        </button>
        {!historical && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => dismissError(report.id)}
          >
            {t("close")}
          </Button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {t(expanded ? "errors.hideDetails" : "errors.details")}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => void copy()}>
          {t(`errors.${copyState}`)}
        </Button>
        {report.count > 1 && (
          <span className="ml-auto text-muted-foreground">
            {t("errors.repeated", { count: report.count })}
          </span>
        )}
      </div>
      {expanded && (
        <section
          // biome-ignore lint/a11y/noNoninteractiveTabindex: 长诊断区必须能用键盘聚焦滚动。
          tabIndex={0}
          aria-label={t("errors.details")}
          className="mt-2 max-h-56 select-text overflow-auto border-t border-border pt-2"
        >
          <pre className="whitespace-pre-wrap break-words font-mono text-xs">
            {copyableError(report)}
          </pre>
        </section>
      )}
    </section>
  );
}

/** 每个 WebView 只挂载一次；不抢焦点，不将错误广播到其他窗口。 */
export function ErrorHost() {
  const { t } = useTranslation("common");
  const reports = useStore(errorStore, (state) => state.reports);
  const history = useStore(errorStore, (state) => state.historyOpen);
  const hasVisibleErrors = reports.some((report) => report.visible);
  const showing = hasVisibleErrors || (history && reports.length > 0);
  const [mount] = useState(() => document.createElement("div"));
  const paused = useRef(new Set<string>());
  const [pause] = useState(() => (id: string, value: boolean) => {
    if (value) paused.current.add(id);
    else paused.current.delete(id);
  });

  useEffect(() => {
    if (!showing) return;
    mount.dataset.errorHost = "";
    // 原生 top layer 保持窗口坐标，DOM 仍属于当前模态框的焦点范围。
    mount.setAttribute("popover", "manual");
    mount.style.cssText =
      "position:fixed;inset:44px 12px auto auto;margin:0;padding:0;border:0;background:transparent;color:inherit;overflow:visible;width:min(380px,calc(100vw - 24px));max-height:calc(100dvh - 56px);z-index:100;pointer-events:none";
    const place = () => {
      const dialogs = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"], [role="alertdialog"]',
        ),
      ).filter(
        (dialog) =>
          dialog.dataset.state !== "closed" &&
          dialog.getAttribute("aria-hidden") !== "true" &&
          !dialog.hidden,
      );
      const parent = dialogs[dialogs.length - 1] ?? document.body;
      if (mount.parentElement !== parent) {
        parent.append(mount);
        mount.removeAttribute("aria-hidden");
        if (typeof mount.showPopover === "function") mount.showPopover();
        else {
          // 较旧的系统 WebKit 没有 top layer，在当前弹窗内显示，保持焦点与点击可用。
          mount.style.top = parent === document.body ? "44px" : "12px";
          mount.style.width =
            parent === document.body
              ? "min(380px,calc(100vw - 24px))"
              : "min(380px,calc(100% - 24px))";
        }
      }
    };
    place();
    const dialogSelector = '[role="dialog"], [role="alertdialog"]';
    const observer = new MutationObserver((mutations) => {
      // 终端与聊天会高频修改 DOM；仅弹窗的挂载、卸载和可见性变化触发宿主定位。
      if (
        mutations.some((mutation) =>
          mutation.type === "attributes"
            ? mutation.target instanceof Element &&
              mutation.target.matches(dialogSelector)
            : [...mutation.addedNodes, ...mutation.removedNodes].some(
                (node) =>
                  node instanceof Element &&
                  (node.matches(dialogSelector) ||
                    node.querySelector(dialogSelector)),
              ),
        )
      )
        place();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state", "aria-hidden", "hidden"],
    });
    return () => {
      observer.disconnect();
      mount.remove();
    };
  }, [mount, showing]);

  useEffect(() => {
    if (!hasVisibleErrors || history) return;
    let last = performance.now();
    let active = document.hasFocus() && document.visibilityState === "visible";
    const update = () => {
      const now = performance.now();
      if (active && !mount.querySelector('[role="menu"]'))
        elapseErrors(now - last, paused.current);
      last = now;
      active = document.hasFocus() && document.visibilityState === "visible";
    };
    const timer = setInterval(update, 250);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [history, hasVisibleErrors, mount]);

  if (!showing) return null;
  return createPortal(
    <aside
      aria-label={t("errors.region")}
      className="pointer-events-auto flex max-h-[calc(100dvh-56px)] flex-col gap-2"
    >
      {history && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-popover p-2 text-xs text-popover-foreground shadow-sm">
          <span className="mr-auto">
            {t("errors.history", { count: reports.length })}
          </span>
          <Button size="xs" variant="ghost" onClick={clearErrors}>
            {t("errors.clear")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setErrorHistoryOpen(false)}
          >
            {t("close")}
          </Button>
        </div>
      )}
      <div
        id="error-history-list"
        className="flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain p-0.5"
        aria-live="polite"
        aria-relevant="additions"
      >
        {(history ? reports : reports.filter((report) => report.visible)).map(
          (report) => (
            <ErrorCard
              key={report.id}
              report={report}
              historical={history}
              pause={pause}
            />
          ),
        )}
      </div>
    </aside>,
    mount,
  );
}

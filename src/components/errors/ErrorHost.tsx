/**
 * 所有窗口共用的错误浮层，提供阅读暂停、详情复制和当前窗口的最近错误。
 * 弹窗打开时把同一个展示节点移入其焦点范围，避免仅提高层级却无法操作。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/controls/button";
import { ContentReveal } from "@/components/controls/content-reveal";
import { dialogCloseIconButtonClassName } from "@/components/controls/close-button";
import { Hint } from "@/components/controls/tooltip";
import { ErrorPresentation } from "@/components/errors/ErrorPresentation";
import Alert02Icon from "@hugeicons/core-free-icons/Alert02Icon";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { writeClipboardText } from "@/lib/clipboard";
import {
  copyableError,
  clearErrors,
  dismissError,
  elapseErrors,
  errorStore,
  ignoreError,
  setErrorHistoryOpen,
  type ErrorReport,
} from "@/lib/errors";

function ErrorCard({
  report,
  historical,
  reveal,
  pause,
  scrollRef,
}: {
  report: ErrorReport;
  historical: boolean;
  reveal: { id: string } | null;
  pause: (id: string, paused: boolean) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation("common");
  const [expanded, setExpanded] = useState(false);
  const [detailHeight, setDetailHeight] = useState(224);
  const card = useRef<HTMLElement>(null);
  const setDetailsOpen = useCallback((open: boolean) => {
    if (open && card.current)
      setDetailHeight(
        Math.max(
          64,
          Math.min(
            224,
            window.innerHeight -
              (card.current
                .querySelector("[data-error-heading]")
                ?.getBoundingClientRect().bottom ??
                card.current.getBoundingClientRect().bottom) -
              24,
          ),
        ),
      );
    setExpanded(open);
  }, []);
  useEffect(() => {
    if (!reveal) return;
    card.current?.scrollIntoView?.({ block: "nearest" });
    setDetailsOpen(true);
  }, [reveal, setDetailsOpen]);
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
      ref={card}
      aria-label={report.title}
      className="relative rounded-lg border border-transparent p-3 text-xs text-popover-foreground"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      <div
        data-error-surface
        aria-hidden="true"
        className="pointer-events-none absolute -inset-px origin-top-left rounded-lg border border-border bg-popover shadow-lg"
      />
      <div className="relative">
        <div data-error-heading className="flex items-start gap-2">
          <HugeiconsIcon
            icon={Alert02Icon}
            size={14}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0 text-destructive"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <button
              type="button"
              className="block w-full min-w-0 cursor-default select-text text-left"
              aria-label={
                historical
                  ? report.title
                  : t("errors.dismiss", { title: report.title })
              }
              aria-expanded={historical ? expanded : undefined}
              onClick={() => {
                if (window.getSelection()?.toString()) return;
                if (historical) setDetailsOpen(!expanded);
                else dismissError(report.id);
              }}
            >
              <span className="block line-clamp-2 break-words font-medium">
                {report.title}
              </span>
            </button>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                aria-expanded={expanded}
                aria-label={t(
                  expanded ? "errors.hideDetails" : "errors.details",
                )}
                onClick={() => setDetailsOpen(!expanded)}
              >
                {t("errors.details")}
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={12}
                  strokeWidth={2}
                  aria-hidden="true"
                  className={`transition-transform duration-control ${expanded ? "rotate-180" : ""}`}
                />
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => void copy()}
              >
                {t(`errors.${copyState}`)}
              </Button>
              {report.count > 1 && (
                <span className="ml-auto text-muted-foreground">
                  {t("errors.repeated", { count: report.count })}
                </span>
              )}
            </div>
            {report.source && (
              <span className="mt-1 block truncate text-muted-foreground">
                {report.source}
              </span>
            )}
            {report.details && (
              <span
                data-error-preview
                className="mt-1 line-clamp-2 select-text break-words text-muted-foreground"
              >
                {report.details}
              </span>
            )}
          </div>
          <div className="flex w-14 shrink-0 flex-col items-stretch gap-1">
            {!historical && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => dismissError(report.id)}
              >
                {t("close")}
              </Button>
            )}
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-label={t("errors.ignoreReport", { title: report.title })}
              onClick={() => ignoreError(report.id)}
            >
              {t("errors.ignore")}
            </Button>
          </div>
        </div>
        <ContentReveal
          open={expanded}
          transitionKey={null}
          scrollRef={scrollRef}
        >
          <section
            // biome-ignore lint/a11y/noNoninteractiveTabindex: 长诊断区必须能用键盘聚焦滚动。
            tabIndex={0}
            aria-label={t("errors.details")}
            className="mt-2 select-text overflow-auto border-t border-border pt-2"
            style={{ maxHeight: detailHeight }}
          >
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">
              {copyableError(report)}
            </pre>
          </section>
        </ContentReveal>
      </div>
    </section>
  );
}

/** 每个 WebView 只挂载一次；不抢焦点，不将错误广播到其他窗口。 */
export function ErrorHost() {
  const { t } = useTranslation("common");
  const reports = useStore(errorStore, (state) => state.reports);
  const history = useStore(errorStore, (state) => state.historyOpen);
  const target = useStore(errorStore, (state) => state.historyTarget);
  const hasVisibleErrors = reports.some((report) => report.visible);
  const showing = hasVisibleErrors || (history && reports.length > 0);
  const [present, setPresent] = useState(showing);
  const attached = showing || present;
  const [mount] = useState(() => document.createElement("div"));
  const paused = useRef(new Set<string>());
  const [pause] = useState(() => (id: string, value: boolean) => {
    if (value) paused.current.add(id);
    else paused.current.delete(id);
  });

  useEffect(() => {
    if (!history) return;
    const inside = (event: Event) =>
      event
        .composedPath()
        .some(
          (node) =>
            node === mount ||
            (node instanceof Element &&
              node.closest("[data-error-history-button]")),
        );
    const outside = (event: Event) => {
      if (!inside(event)) setErrorHistoryOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !mount.querySelector('[role="menu"]')
      )
        setErrorHistoryOpen(false);
    };
    const blur = () => setErrorHistoryOpen(false);
    const visibility = () => {
      if (document.hidden) blur();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [history, mount]);

  useEffect(() => {
    if (!attached) return;
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
          !dialog.closest(
            '[inert], [hidden], [aria-hidden="true"], [data-state="closed"]',
          ),
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
              (mutation.target.matches(dialogSelector) ||
                mutation.target.querySelector(dialogSelector))
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
      attributeFilter: ["data-state", "aria-hidden", "hidden", "inert"],
    });
    return () => {
      observer.disconnect();
      mount.remove();
    };
  }, [mount, attached]);

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

  return createPortal(
    <ErrorPresentation
      reports={reports}
      history={history}
      label={t("errors.region")}
      onPresentChange={setPresent}
      renderHeader={(count) => (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-popover p-2 text-xs text-popover-foreground shadow-sm">
          <span className="mr-auto">{t("errors.history", { count })}</span>
          <Button type="button" size="xs" variant="ghost" onClick={clearErrors}>
            {t("errors.clear")}
          </Button>
          <Hint content={t("close")}>
            <button
              type="button"
              aria-label={t("close")}
              className={dialogCloseIconButtonClassName}
              onClick={() => setErrorHistoryOpen(false)}
            >
              <HugeiconsIcon
                icon={Cancel01Icon}
                size={14}
                strokeWidth={2}
                aria-hidden="true"
              />
            </button>
          </Hint>
        </div>
      )}
      renderCard={(report, historical, scrollRef) => (
        <ErrorCard
          report={report}
          historical={historical}
          reveal={history && target?.id === report.id ? target : null}
          pause={pause}
          scrollRef={scrollRef}
        />
      )}
    />,
    mount,
  );
}

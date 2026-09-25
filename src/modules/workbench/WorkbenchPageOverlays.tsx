/**
 * 为每个工作页提供稳定的浮层宿主，统一管理页内模态、层级和焦点。
 * 页面隐藏只暂停交互，显式关闭才卸载浮层；不创建原生窗口或持有业务任务。
 */
import { Button } from "@/components/controls/button";
import { cn } from "@/lib/utils";
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

type Layer = { id: string; modal: boolean };
type PageScope = {
  visible: boolean;
  focused: boolean;
  host: HTMLDivElement | null;
  layers: Layer[];
  topModalId: string | null;
  register: (layer: Layer) => () => void;
  raise: (id: string) => void;
};
const PageContext = createContext<PageScope | null>(null);
const PortalContext = createContext<HTMLElement | null>(null);

function usePageScope() {
  const scope = useContext(PageContext);
  if (!scope) throw new Error("Workbench page overlays require a page scope");
  return scope;
}

/** 页面可见性供展示查询使用；focused 仅表示所属分组当前接收工作页操作。 */
export function useWorkbenchPageActivity() {
  const { visible, focused } = usePageScope();
  return { visible, focused };
}

/**
 * 下级非模态菜单可将 Portal 定位到当前浮层内，避免逃逸到 document.body。
 * 菜单自身仍需关闭全局模态行为，并在页面隐藏时收起。
 */
export function useWorkbenchOverlayContainer() {
  const container = useContext(PortalContext);
  const scope = usePageScope();
  return container ?? scope.host;
}

/** 由稳定页面实例池创建；宿主与页面一起跨分组移动，不随可见性重建。 */
export function WorkbenchPageScope({
  visible,
  focused,
  children,
}: {
  visible: boolean;
  focused: boolean;
  children: ReactNode;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [layers, setLayers] = useState<Layer[]>([]);
  const register = useCallback((layer: Layer) => {
    setLayers((current) => [...current, layer]);
    return () =>
      setLayers((current) => current.filter((item) => item.id !== layer.id));
  }, []);
  const raise = useCallback((id: string) => {
    setLayers((current) => {
      const layer = current.find((item) => item.id === id);
      if (!layer || current[current.length - 1] === layer) return current;
      return [...current.filter((item) => item.id !== id), layer];
    });
  }, []);
  const orderedLayers = useMemo(
    () => [
      ...layers.filter((layer) => !layer.modal),
      ...layers.filter((layer) => layer.modal),
    ],
    [layers],
  );
  const topLayer = orderedLayers[orderedLayers.length - 1];
  const topModalId = topLayer?.modal ? topLayer.id : null;
  const modal = topModalId !== null;
  const value = useMemo(
    () => ({
      visible,
      focused,
      host,
      layers: orderedLayers,
      topModalId,
      register,
      raise,
    }),
    [visible, focused, host, orderedLayers, topModalId, register, raise],
  );
  return (
    <PageContext.Provider value={value}>
      <div
        data-workbench-page-scope=""
        className="relative isolate h-full w-full overflow-hidden [contain:layout_paint]"
        style={{
          visibility: visible ? "visible" : "hidden",
          opacity: visible ? 1 : 0,
        }}
        aria-hidden={!visible}
        inert={!visible}
      >
        <div
          className="absolute inset-0 z-0"
          inert={modal || !visible}
          aria-hidden={modal || !visible}
        >
          {children}
        </div>
        <div
          ref={setHost}
          data-workbench-overlay-host=""
          className="pointer-events-none absolute inset-0 z-10"
        />
      </div>
    </PageContext.Provider>
  );
}

export type WorkbenchPageOverlayProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
};

export type WorkbenchPageDialogProps = WorkbenchPageOverlayProps & {
  /** 仅响应本页遮罩；编辑草稿的对话框默认不启用。 */
  dismissOnBackdrop?: boolean;
};

/** 非模态页内浮窗，点击置前；位置与尺寸可由业务通过 style 控制。 */
export function WorkbenchPageWindow(props: WorkbenchPageOverlayProps) {
  return <PageOverlay {...props} modal={false} />;
}

/** 模态范围仅限当前页，保留宿主导航及其他分屏的可操作性。 */
export function WorkbenchPageDialog(props: WorkbenchPageDialogProps) {
  return <PageOverlay {...props} modal />;
}

function PageOverlay({
  open,
  ...props
}: WorkbenchPageDialogProps & { modal: boolean }) {
  return open ? <OpenPageOverlay {...props} /> : null;
}

const focusableSelector =
  'button, input, select, textarea, a[href], [tabindex], [contenteditable="true"]';

/** 隐藏的父容器不会反映在子元素的 display 上，恢复焦点也必须逐层检查。 */
function isFocusAvailable(element: HTMLElement) {
  if (!element.isConnected || element.matches(":disabled")) return false;
  for (
    let current: HTMLElement | null = element;
    current;
    current = current.parentElement
  ) {
    const style = getComputedStyle(current);
    if (
      current.inert ||
      current.hidden ||
      current.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden"
    )
      return false;
  }
  return true;
}

function focusableElements(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(focusableSelector),
  ).filter((element) => element.tabIndex >= 0 && isFocusAvailable(element));
}

/** 打开期间始终保留同一个 Portal 与内容树，后台不注册全局焦点锁或滚动锁。 */
function OpenPageOverlay({
  modal,
  title,
  children,
  onOpenChange,
  className,
  style,
  dismissOnBackdrop = false,
}: Omit<WorkbenchPageDialogProps, "open"> & { modal: boolean }) {
  const scope = usePageScope();
  const { register, raise, visible, focused, host, layers, topModalId } = scope;
  const { t } = useTranslation("common");
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const previousFocus = useRef<HTMLElement | null>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const activeRef = useRef(false);
  const blocked = topModalId !== null && topModalId !== id;
  const active = visible && !blocked;
  activeRef.current = active && focused;

  useLayoutEffect(() => register({ id, modal }), [id, modal, register]);

  useLayoutEffect(() => {
    if (!host) return;
    const element = document.activeElement;
    const panel = panelRef.current;
    previousFocus.current = element instanceof HTMLElement ? element : null;
    return () => {
      const previous = previousFocus.current;
      const focusAtClose = document.activeElement;
      const restore =
        activeRef.current &&
        (focusAtClose === document.body ||
          panel
            ?.closest("[data-workbench-page-overlay]")
            ?.contains(focusAtClose));
      // 先移除当前层并解除底层 inert，再归还焦点；后台关闭不能抢走其他页焦点。
      queueMicrotask(() => {
        if (
          restore &&
          previous &&
          isFocusAvailable(previous) &&
          (document.activeElement === focusAtClose ||
            document.activeElement === document.body)
        ) {
          previous.focus({ preventScroll: true });
        }
      });
    };
  }, [host]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!host || !panel || !portalContainer) return;
    if (!active) {
      const element = document.activeElement;
      if (element instanceof HTMLElement && portalContainer.contains(element)) {
        lastFocus.current = element;
        element.blur();
      }
      return;
    }
    if (!focused || !modal) return;
    const target = lastFocus.current;
    (target && portalContainer.contains(target) && isFocusAvailable(target)
      ? target
      : (focusableElements(panel)[0] ?? panel)
    ).focus({ preventScroll: true });
  }, [active, focused, modal, host, portalContainer]);

  if (!host) return null;
  return createPortal(
    <div
      ref={setPortalContainer}
      data-workbench-page-overlay={modal ? "dialog" : "window"}
      className="pointer-events-none absolute inset-0"
      style={{ zIndex: layers.findIndex((layer) => layer.id === id) + 1 }}
      inert={!active}
      aria-hidden={!active}
      onFocusCapture={(event) => {
        if (portalContainer?.contains(event.target))
          lastFocus.current = event.target;
      }}
      onKeyDown={(event) => {
        if (!active || event.defaultPrevented || event.nativeEvent.isComposing)
          return;
        // 子菜单先处理 Escape，页内浮层不监听其他页面的键盘事件。
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onOpenChange(false);
        }
        if (
          modal &&
          event.key === "Tab" &&
          panelRef.current &&
          portalContainer
        ) {
          const elements = focusableElements(portalContainer);
          const first = elements[0] ?? panelRef.current;
          const last = elements[elements.length - 1] ?? panelRef.current;
          const current = document.activeElement;
          if (
            event.shiftKey
              ? current === first || current === panelRef.current
              : current === last || current === panelRef.current
          ) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
          }
        }
      }}
    >
      {modal && (
        <div
          role="presentation"
          data-workbench-page-backdrop=""
          className="pointer-events-auto absolute inset-0 isolate bg-black/30 supports-backdrop-filter:backdrop-blur-sm"
          onPointerDown={(event) => {
            // 只处理从本页遮罩开始的主键操作，内容拖选和其他页面点击不关闭。
            if (
              !active ||
              !dismissOnBackdrop ||
              event.button !== 0 ||
              event.ctrlKey
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            onOpenChange(false);
          }}
        />
      )}
      <div
        ref={panelRef}
        role="dialog"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        onPointerDownCapture={() => {
          if (!blocked) raise(id);
        }}
        className={cn(
          "pointer-events-auto absolute flex max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-lg bg-popover text-xs text-popover-foreground shadow-xl ring-1 ring-foreground/5 outline-none dark:ring-foreground/10",
          modal
            ? "top-1/2 left-1/2 w-[28rem] -translate-x-1/2 -translate-y-1/2"
            : "top-4 right-4 w-80",
          className,
        )}
        style={style}
      >
        <header className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
          <h2
            id={`${id}-title`}
            className="min-w-0 flex-1 truncate text-sm font-medium"
          >
            {title}
          </h2>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("close")}
          </Button>
        </header>
        <PortalContext.Provider value={portalContainer}>
          <div className="app-scrollbar min-h-0 overflow-auto p-4">
            {children}
          </div>
        </PortalContext.Provider>
      </div>
    </div>,
    host,
  );
}

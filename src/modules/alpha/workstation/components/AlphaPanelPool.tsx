/**
 * 本文件实现 Alpha 工作台的稳定面板挂载层。
 * 面板渲染到固定 DOM 容器，网格宿主替换时仅移动容器，不重建面板 React 子树。
 */

import { cn } from "@/lib/utils";
import type { AlphaPanelInstance } from "@/modules/alpha/workstation/model";
import { resolveAlphaPanelSymbol } from "@/modules/alpha/workstation/state";
import type { AlphaPanelRegistry } from "@/modules/alpha/workstation/registry";
import {
  Component,
  createContext,
  forwardRef,
  type ComponentPropsWithoutRef,
  type ErrorInfo,
  type ForwardedRef,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

type MountRegistry = {
  registerContainer(panelId: string, container: HTMLDivElement | null): void;
  registerHost(panelId: string, host: HTMLDivElement | null): void;
};

const AlphaPanelMountContext = createContext<MountRegistry | null>(null);

type AlphaPanelPoolProps = {
  panels: readonly AlphaPanelInstance[];
  registry: AlphaPanelRegistry;
  mainSymbol: string;
  visible: boolean;
  children: ReactNode;
};

type BoundaryProps = {
  resetToken: string;
  fallback: ReactNode;
  children: ReactNode;
};

type BoundaryState = {
  resetToken: string;
  failed: boolean;
};

class AlphaPanelErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = {
    resetToken: this.props.resetToken,
    failed: false,
  };

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: BoundaryState,
  ): Partial<BoundaryState> | null {
    if (props.resetToken === state.resetToken) return null;
    return { resetToken: props.resetToken, failed: false };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("[alpha-workstation] panel render failed", error, info);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

type PanelStatusProps = {
  state: "loading" | "unknown" | "failed";
  panelType?: string;
};

function AlphaPanelStatus({ state, panelType }: PanelStatusProps) {
  const { t } = useTranslation("alpha");
  return (
    <div
      className="grid h-full min-h-20 place-items-center p-4 text-center text-xs text-muted-foreground"
      role={state === "loading" ? "status" : "alert"}
    >
      {state === "loading" && t("workstation.panel.loading")}
      {state === "unknown" &&
        t("workstation.panel.unknown", { type: panelType })}
      {state === "failed" && t("workstation.panel.failed")}
    </div>
  );
}

type PooledPanelProps = {
  panel: AlphaPanelInstance;
  registry: AlphaPanelRegistry;
  mainSymbol: string;
  visible: boolean;
};

function PooledPanel({
  panel,
  registry,
  mainSymbol,
  visible,
}: PooledPanelProps) {
  const mounts = useContext(AlphaPanelMountContext);
  if (!mounts) {
    throw new Error("PooledPanel must be rendered inside AlphaPanelPool");
  }
  const [container] = useState(() => {
    const element = document.createElement("div");
    element.className = "absolute inset-0 min-h-0 min-w-0 overflow-hidden";
    element.dataset.alphaPanel = panel.id;
    return element;
  });
  const descriptor = registry.get(panel.type);
  const vtSymbol = resolveAlphaPanelSymbol(panel.binding, mainSymbol);

  useLayoutEffect(() => {
    mounts.registerContainer(panel.id, container);
    return () => {
      mounts.registerContainer(panel.id, null);
      container.remove();
    };
  }, [container, mounts, panel.id]);

  useLayoutEffect(() => {
    container.style.visibility = visible ? "visible" : "hidden";
    container.style.pointerEvents = visible ? "auto" : "none";
    container.inert = !visible;
    container.setAttribute("aria-hidden", String(!visible));
  }, [container, visible]);

  return createPortal(
    descriptor ? (
      <AlphaPanelErrorBoundary
        resetToken={JSON.stringify([panel.type, vtSymbol, panel.config])}
        fallback={<AlphaPanelStatus state="failed" />}
      >
        <Suspense fallback={<AlphaPanelStatus state="loading" />}>
          <descriptor.Component
            panelId={panel.id}
            vtSymbol={vtSymbol}
            config={panel.config}
            visible={visible}
          />
        </Suspense>
      </AlphaPanelErrorBoundary>
    ) : (
      <AlphaPanelStatus state="unknown" panelType={panel.type} />
    ),
    container,
  );
}

/**
 * 保持 Alpha 面板实例稳定，并把固定容器连接到对应的 `AlphaPanelHost`。
 *
 * `children` 通常是网格；面板宿主暂时消失时，实例会留在隐藏 depot 中。
 */
export function AlphaPanelPool({
  panels,
  registry,
  mainSymbol,
  visible,
  children,
}: AlphaPanelPoolProps) {
  const depotRef = useRef<HTMLDivElement>(null);
  const hostsRef = useRef(new Map<string, HTMLDivElement>());
  const containersRef = useRef(new Map<string, HTMLDivElement>());

  const attach = useCallback((panelId: string) => {
    const container = containersRef.current.get(panelId);
    const target = hostsRef.current.get(panelId) ?? depotRef.current;
    if (container && target && container.parentNode !== target) {
      target.appendChild(container);
    }
  }, []);

  const mounts = useMemo<MountRegistry>(
    () => ({
      registerContainer(panelId, container) {
        if (container) containersRef.current.set(panelId, container);
        else containersRef.current.delete(panelId);
        attach(panelId);
      },
      registerHost(panelId, host) {
        if (host) hostsRef.current.set(panelId, host);
        else hostsRef.current.delete(panelId);
        attach(panelId);
      },
    }),
    [attach],
  );

  return (
    <AlphaPanelMountContext.Provider value={mounts}>
      {children}
      <div ref={depotRef} className="hidden" aria-hidden />
      {panels.map((panel) => (
        <PooledPanel
          key={panel.id}
          panel={panel}
          registry={registry}
          mainSymbol={mainSymbol}
          visible={visible}
        />
      ))}
    </AlphaPanelMountContext.Provider>
  );
}

type AlphaPanelHostProps = ComponentPropsWithoutRef<"div"> & {
  panelId: string;
};

function assignRef<T>(ref: ForwardedRef<T>, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/**
 * 声明一个面板 DOM 宿主。
 *
 * 宿主可以由网格安全替换；固定面板容器会自动移入新宿主，转发的 ref 供布局库测量。
 */
export const AlphaPanelHost = forwardRef<HTMLDivElement, AlphaPanelHostProps>(
  function AlphaPanelHost({ panelId, className, ...props }, forwardedRef) {
    const mounts = useContext(AlphaPanelMountContext);
    if (!mounts) {
      throw new Error("AlphaPanelHost must be rendered inside AlphaPanelPool");
    }
    const setHost = useCallback(
      (host: HTMLDivElement | null) => {
        mounts.registerHost(panelId, host);
        assignRef(forwardedRef, host);
      },
      [forwardedRef, mounts, panelId],
    );

    return (
      <div
        {...props}
        ref={setHost}
        className={cn("relative min-h-0 min-w-0 overflow-hidden", className)}
        data-alpha-panel-host={panelId}
      />
    );
  },
);

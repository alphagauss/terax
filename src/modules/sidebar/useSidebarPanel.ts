import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
  getWorkspaceValue,
  setWorkspaceValue,
} from "@/modules/workspace-process";
import type { SidebarViewId } from "./types";
import {
  clampPanelWidth,
  PRIMARY_SIDEBAR_DEFAULT_WIDTH,
  PRIMARY_SIDEBAR_MAX_WIDTH,
  PRIMARY_SIDEBAR_MIN_WIDTH,
} from "./layout";

export const SIDEBAR_DEFAULT_WIDTH = PRIMARY_SIDEBAR_DEFAULT_WIDTH;
export const SIDEBAR_MIN_WIDTH = PRIMARY_SIDEBAR_MIN_WIDTH;
export const SIDEBAR_MAX_WIDTH = PRIMARY_SIDEBAR_MAX_WIDTH;
const SIDEBAR_WIDTH_STORAGE_KEY = "sidebar:width";
const SIDEBAR_VIEW_STORAGE_KEY = "sidebar:view";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "sidebar:collapsed";
function clampSidebarWidth(width: number): number {
  return clampPanelWidth(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
}

function readSidebarWidth(): number {
  const stored = getWorkspaceValue<number>(SIDEBAR_WIDTH_STORAGE_KEY);
  return Number.isFinite(stored)
    ? clampSidebarWidth(stored as number)
    : SIDEBAR_DEFAULT_WIDTH;
}

function readSidebarView(): SidebarViewId {
  const stored = getWorkspaceValue<string>(SIDEBAR_VIEW_STORAGE_KEY);
  if (stored === "explorer" || stored === "source-control") return stored;
  return "explorer";
}

function readSidebarCollapsed(): boolean {
  const stored = getWorkspaceValue<boolean>(SIDEBAR_COLLAPSED_STORAGE_KEY);
  if (stored !== undefined) return stored;
  return false;
}

type FocusableExplorer = {
  focus: () => void;
  isFocused: () => boolean;
};

export function useSidebarPanel(
  explorerRef: RefObject<FocusableExplorer | null>,
) {
  const sidebarRef = useRef<PanelImperativeHandle | null>(null);
  const sidebarWidthRef = useRef(readSidebarWidth());
  const sidebarWidthWriteTimerRef = useRef(0);
  const explorerReturnFocusRef = useRef<HTMLElement | null>(null);
  const [sidebarView, setSidebarViewState] =
    useState<SidebarViewId>(readSidebarView);
  const [initialSidebarCollapsed] = useState(readSidebarCollapsed);
  const collapsedRef = useRef(initialSidebarCollapsed);

  const persistSidebarView = useCallback((view: SidebarViewId) => {
    setSidebarViewState(view);
    void setWorkspaceValue(SIDEBAR_VIEW_STORAGE_KEY, view);
  }, []);

  const persistSidebarCollapsed = useCallback((collapsed: boolean) => {
    if (collapsedRef.current === collapsed) return;
    collapsedRef.current = collapsed;
    void setWorkspaceValue(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed);
  }, []);

  const toggleSidebar = useCallback(() => {
    const p = sidebarRef.current;
    if (!p) return;
    if (p.getSize().asPercentage <= 0) p.resize(`${sidebarWidthRef.current}px`);
    else p.collapse();
  }, []);

  const cycleSidebarView = useCallback(
    (view: SidebarViewId) => {
      const panel = sidebarRef.current;
      const collapsed = panel ? panel.getSize().asPercentage <= 0 : false;
      if (collapsed) {
        if (panel) panel.resize(`${sidebarWidthRef.current}px`);
        if (view !== sidebarView) persistSidebarView(view);
        return;
      }
      if (view === sidebarView) {
        panel?.collapse();
        return;
      }
      persistSidebarView(view);
    },
    [persistSidebarView, sidebarView],
  );

  const persistSidebarWidth = useCallback((next: number) => {
    sidebarWidthRef.current = next;
    if (sidebarWidthWriteTimerRef.current) {
      window.clearTimeout(sidebarWidthWriteTimerRef.current);
    }
    sidebarWidthWriteTimerRef.current = window.setTimeout(() => {
      sidebarWidthWriteTimerRef.current = 0;
      void setWorkspaceValue(SIDEBAR_WIDTH_STORAGE_KEY, next);
    }, 200);
  }, []);

  useEffect(() => {
    return () => {
      if (sidebarWidthWriteTimerRef.current) {
        window.clearTimeout(sidebarWidthWriteTimerRef.current);
      }
    };
  }, []);

  const toggleExplorerFocus = useCallback(() => {
    const explorer = explorerRef.current;
    const panel = sidebarRef.current;
    const collapsed = panel ? panel.getSize().asPercentage <= 0 : false;
    if (sidebarView !== "explorer" || collapsed) {
      if (panel && collapsed) panel.resize(`${sidebarWidthRef.current}px`);
      if (sidebarView !== "explorer") persistSidebarView("explorer");
      const active = document.activeElement;
      explorerReturnFocusRef.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
      requestAnimationFrame(() => explorerRef.current?.focus());
      return;
    }
    if (!explorer) return;
    if (explorer.isFocused()) {
      const target = explorerReturnFocusRef.current;
      explorerReturnFocusRef.current = null;
      if (target && document.body.contains(target)) {
        target.focus();
      } else {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      return;
    }
    const active = document.activeElement;
    explorerReturnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    explorer.focus();
  }, [explorerRef, persistSidebarView, sidebarView]);

  return {
    sidebarRef,
    sidebarWidthRef,
    sidebarView,
    initialSidebarCollapsed,
    persistSidebarView,
    persistSidebarCollapsed,
    toggleSidebar,
    cycleSidebarView,
    persistSidebarWidth,
    toggleExplorerFocus,
  };
}

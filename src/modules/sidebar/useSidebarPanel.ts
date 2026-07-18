import { type RefObject, useCallback, useRef, useState } from "react";
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
  const explorerReturnFocusRef = useRef<HTMLElement | null>(null);
  const [sidebarView, setSidebarViewState] =
    useState<SidebarViewId>(readSidebarView);
  const [initialSidebarCollapsed] = useState(readSidebarCollapsed);
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(
    initialSidebarCollapsed,
  );
  const collapsedRef = useRef(initialSidebarCollapsed);

  const persistSidebarView = useCallback((view: SidebarViewId) => {
    setSidebarViewState(view);
    void setWorkspaceValue(SIDEBAR_VIEW_STORAGE_KEY, view);
  }, []);

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarCollapsedState(collapsed);
    if (collapsedRef.current === collapsed) return;
    collapsedRef.current = collapsed;
    void setWorkspaceValue(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed);
  }, []);

  const toggleSidebar = useCallback(() => {
    const p = sidebarRef.current;
    if (!p) return;
    if (p.getSize().asPercentage <= 0) {
      p.resize(`${sidebarWidthRef.current}px`);
      setSidebarCollapsed(false);
    } else {
      p.collapse();
      setSidebarCollapsed(true);
    }
  }, [setSidebarCollapsed]);

  const cycleSidebarView = useCallback(
    (view: SidebarViewId) => {
      const panel = sidebarRef.current;
      const collapsed = panel ? panel.getSize().asPercentage <= 0 : false;
      if (collapsed) {
        if (panel) panel.resize(`${sidebarWidthRef.current}px`);
        setSidebarCollapsed(false);
        if (view !== sidebarView) persistSidebarView(view);
        return;
      }
      if (view === sidebarView) {
        panel?.collapse();
        setSidebarCollapsed(true);
        return;
      }
      persistSidebarView(view);
    },
    [persistSidebarView, setSidebarCollapsed, sidebarView],
  );

  const commitSidebarLayout = useCallback(() => {
    const size = sidebarRef.current?.getSize().inPixels ?? 0;
    const collapsed = size <= 0;
    if (!collapsed) {
      const width = clampSidebarWidth(size);
      if (sidebarWidthRef.current !== width) {
        sidebarWidthRef.current = width;
        void setWorkspaceValue(SIDEBAR_WIDTH_STORAGE_KEY, width);
      }
    }
    setSidebarCollapsed(collapsed);
  }, [setSidebarCollapsed]);

  const toggleExplorerFocus = useCallback(() => {
    const explorer = explorerRef.current;
    const panel = sidebarRef.current;
    const collapsed = panel ? panel.getSize().asPercentage <= 0 : false;
    if (sidebarView !== "explorer" || collapsed) {
      if (panel && collapsed) panel.resize(`${sidebarWidthRef.current}px`);
      if (collapsed) setSidebarCollapsed(false);
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
  }, [explorerRef, persistSidebarView, setSidebarCollapsed, sidebarView]);

  return {
    sidebarRef,
    sidebarWidthRef,
    sidebarView,
    sidebarCollapsed,
    initialSidebarCollapsed,
    persistSidebarView,
    toggleSidebar,
    cycleSidebarView,
    commitSidebarLayout,
    toggleExplorerFocus,
  };
}

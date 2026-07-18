import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
  getWorkspaceValue,
  setWorkspaceValue,
} from "@/modules/workspace-process";
import {
  clampPanelWidth,
  SECONDARY_SIDEBAR_DEFAULT_WIDTH,
  SECONDARY_SIDEBAR_MAX_WIDTH,
  SECONDARY_SIDEBAR_MIN_WIDTH,
} from "./layout";

const WIDTH_STORAGE_KEY = "sidebar:secondary:width";
const VIEW_STORAGE_KEY = "sidebar:secondary:view";
const COLLAPSED_STORAGE_KEY = "sidebar:secondary:collapsed";

function readWidth(): number {
  const stored = getWorkspaceValue<number>(WIDTH_STORAGE_KEY);
  return Number.isFinite(stored)
    ? clampPanelWidth(
        stored as number,
        SECONDARY_SIDEBAR_MIN_WIDTH,
        SECONDARY_SIDEBAR_MAX_WIDTH,
      )
    : SECONDARY_SIDEBAR_DEFAULT_WIDTH;
}

function readCollapsed(): boolean {
  return getWorkspaceValue<boolean>(COLLAPSED_STORAGE_KEY) ?? true;
}

function readView(viewIds: readonly string[]): string | null {
  const stored = getWorkspaceValue<string>(VIEW_STORAGE_KEY);
  if (stored && viewIds.includes(stored)) return stored;
  return viewIds[0] ?? null;
}

export function useSecondarySidebarPanel(viewIds: readonly string[]) {
  const panelRef = useRef<PanelImperativeHandle | null>(null);
  const widthRef = useRef(readWidth());
  const [initialCollapsed] = useState(readCollapsed);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const collapsedRef = useRef(initialCollapsed);
  const [activeView, setActiveView] = useState(() => readView(viewIds));

  useEffect(() => {
    if (activeView && viewIds.includes(activeView)) return;
    setActiveView(readView(viewIds));
  }, [activeView, viewIds]);

  const persistView = useCallback(
    (view: string) => {
      if (!viewIds.includes(view)) return;
      setActiveView(view);
      void setWorkspaceValue(VIEW_STORAGE_KEY, view);
    },
    [viewIds],
  );

  const persistCollapsed = useCallback((next: boolean) => {
    setCollapsed(next);
    if (collapsedRef.current === next) return;
    collapsedRef.current = next;
    void setWorkspaceValue(COLLAPSED_STORAGE_KEY, next);
  }, []);

  const commitLayout = useCallback(() => {
    const size = panelRef.current?.getSize().inPixels ?? 0;
    const nextCollapsed = size <= 0;
    if (!nextCollapsed) {
      const width = clampPanelWidth(
        size,
        SECONDARY_SIDEBAR_MIN_WIDTH,
        SECONDARY_SIDEBAR_MAX_WIDTH,
      );
      if (widthRef.current !== width) {
        widthRef.current = width;
        void setWorkspaceValue(WIDTH_STORAGE_KEY, width);
      }
    }
    persistCollapsed(nextCollapsed);
  }, [persistCollapsed]);

  const toggle = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (panel.getSize().asPercentage <= 0) {
      panel.resize(`${widthRef.current}px`);
      persistCollapsed(false);
    } else {
      panel.collapse();
      persistCollapsed(true);
    }
  }, [persistCollapsed]);

  const open = useCallback(() => {
    const panel = panelRef.current;
    if (!panel || panel.getSize().asPercentage > 0) return;
    panel.resize(`${widthRef.current}px`);
    persistCollapsed(false);
  }, [persistCollapsed]);

  const close = useCallback(() => {
    panelRef.current?.collapse();
    persistCollapsed(true);
  }, [persistCollapsed]);

  return {
    panelRef,
    widthRef,
    activeView,
    collapsed,
    initialCollapsed,
    persistView,
    commitLayout,
    open,
    close,
    toggle,
  };
}

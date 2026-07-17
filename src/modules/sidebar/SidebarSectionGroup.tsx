import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  getWorkspaceValue,
  setWorkspaceValue,
} from "@/modules/workspace-process";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
  normalizeSidebarSectionLayout,
  SIDEBAR_SECTION_HEADER_HEIGHT,
  type SidebarSectionLayout,
} from "./sectionLayout";

export type SidebarSectionRenderState = {
  expanded: boolean;
  toggle: () => void;
};

export type SidebarSectionDefinition = {
  id: string;
  title: ReactNode;
  badge?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode | ((state: SidebarSectionRenderState) => ReactNode);
  defaultSize: number;
  minSize: number;
  defaultCollapsed?: boolean;
  preservePixelSize?: boolean;
  render: (state: SidebarSectionRenderState) => ReactNode;
};

type Props = {
  id: string;
  sections: readonly SidebarSectionDefinition[];
  className?: string;
};

let activeSidebarSectionTransition: ViewTransition | null = null;
let cleanupActiveSidebarSectionTransition: (() => void) | null = null;

function storageKey(id: string): string {
  return `sidebar:sections:${id}`;
}

export function SidebarSectionGroup({ id, sections, className }: Props) {
  const transitionScope = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [initialLayout] = useState(() =>
    normalizeSidebarSectionLayout(
      getWorkspaceValue<unknown>(storageKey(id)),
      sections.map((section) => ({
        id: section.id,
        defaultSize: section.defaultSize,
        minSize: section.minSize,
        defaultCollapsed: section.defaultCollapsed,
      })),
    ),
  );
  const panelRefs = useRef(new Map<string, PanelImperativeHandle>());
  const sizesRef = useRef(
    new Map(
      Object.entries(initialLayout.sections).map(([sectionId, item]) => [
        sectionId,
        item.size,
      ]),
    ),
  );
  const collapsedRef = useRef(
    new Map(
      Object.entries(initialLayout.sections).map(([sectionId, item]) => [
        sectionId,
        item.collapsed,
      ]),
    ),
  );
  const [collapsedSections, setCollapsedSections] = useState(
    () =>
      new Set(
        Object.entries(initialLayout.sections)
          .filter(([, item]) => item.collapsed)
          .map(([sectionId]) => sectionId),
      ),
  );
  const panelElementsRef = useRef(new Map<string, HTMLDivElement>());
  const layoutFrameRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (layoutFrameRef.current !== null) {
        window.cancelAnimationFrame(layoutFrameRef.current);
      }
    };
  }, []);

  const setCollapsed = useCallback((sectionId: string, collapsed: boolean) => {
    if (collapsedRef.current.get(sectionId) === collapsed) return;
    collapsedRef.current.set(sectionId, collapsed);
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (collapsed) next.add(sectionId);
      else next.delete(sectionId);
      return next;
    });
  }, []);

  const persistLayout = useCallback(() => {
    const next: SidebarSectionLayout = { version: 1, sections: {} };
    for (const section of sections) {
      next.sections[section.id] = {
        size: sizesRef.current.get(section.id) ?? section.defaultSize,
        collapsed: collapsedRef.current.get(section.id) ?? false,
      };
    }
    void setWorkspaceValue(storageKey(id), next);
  }, [id, sections]);

  const handleLayoutChanged = useCallback(() => {
    if (layoutFrameRef.current !== null) {
      window.cancelAnimationFrame(layoutFrameRef.current);
    }
    layoutFrameRef.current = window.requestAnimationFrame(() => {
      layoutFrameRef.current = null;
      for (const section of sections) {
        const panel = panelRefs.current.get(section.id);
        if (!panel) continue;
        const collapsed = panel.isCollapsed();
        setCollapsed(section.id, collapsed);
        if (!collapsed) {
          sizesRef.current.set(section.id, panel.getSize().inPixels);
        }
      }
      persistLayout();
    });
  }, [persistLayout, sections, setCollapsed]);

  const toggleSection = useCallback(
    (section: SidebarSectionDefinition) => {
      const panel = panelRefs.current.get(section.id);
      if (!panel) return;
      const wasCollapsed = panel.isCollapsed();
      if (!wasCollapsed) {
        sizesRef.current.set(section.id, panel.getSize().inPixels);
      }

      const updateLayout = () => {
        flushSync(() => {
          if (wasCollapsed) panel.expand();
          else panel.collapse();
          setCollapsed(section.id, panel.isCollapsed());
        });
      };
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      if (reduceMotion || typeof document.startViewTransition !== "function") {
        updateLayout();
        return;
      }

      activeSidebarSectionTransition?.skipTransition();
      cleanupActiveSidebarSectionTransition?.();
      const elements = sections.flatMap((item) => {
        const element = panelElementsRef.current.get(item.id);
        return element ? [element] : [];
      });
      elements.forEach((element, index) => {
        element.style.viewTransitionName = `terax-sidebar-section-${transitionScope}-${index}`;
      });
      document.documentElement.classList.add("sidebar-section-view-transition");
      const transition = document.startViewTransition(updateLayout);
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        for (const element of elements) {
          element.style.removeProperty("view-transition-name");
        }
        if (activeSidebarSectionTransition !== transition) return;
        activeSidebarSectionTransition = null;
        cleanupActiveSidebarSectionTransition = null;
        document.documentElement.classList.remove(
          "sidebar-section-view-transition",
        );
      };
      activeSidebarSectionTransition = transition;
      cleanupActiveSidebarSectionTransition = cleanup;
      void transition.finished.then(cleanup, cleanup);
    },
    [sections, setCollapsed, transitionScope],
  );

  return (
    <ResizablePanelGroup
      id={`sidebar-sections-${id}`}
      orientation="vertical"
      className={cn("min-h-0 flex-1", className)}
      onLayoutChanged={handleLayoutChanged}
    >
      {sections.map((section, index) => {
        const collapsed = collapsedSections.has(section.id);
        const state: SidebarSectionRenderState = {
          expanded: !collapsed,
          toggle: () => toggleSection(section),
        };
        const saved = initialLayout.sections[section.id];
        return (
          <Fragment key={section.id}>
            {index > 0 ? <ResizableHandle /> : null}
            <ResizablePanel
              id={`${id}-${section.id}`}
              panelRef={(handle) => {
                if (handle) panelRefs.current.set(section.id, handle);
                else panelRefs.current.delete(section.id);
              }}
              elementRef={(element) => {
                if (element) panelElementsRef.current.set(section.id, element);
                else panelElementsRef.current.delete(section.id);
              }}
              defaultSize={
                saved?.collapsed
                  ? `${SIDEBAR_SECTION_HEADER_HEIGHT}px`
                  : `${saved?.size ?? section.defaultSize}px`
              }
              minSize={`${section.minSize}px`}
              collapsible
              collapsedSize={`${SIDEBAR_SECTION_HEADER_HEIGHT}px`}
              groupResizeBehavior={
                section.preservePixelSize
                  ? "preserve-pixel-size"
                  : "preserve-relative-size"
              }
              className="flex min-h-0 flex-col bg-sidebar"
            >
              <SidebarSectionHeader
                title={section.title}
                badge={section.badge}
                description={section.description}
                expanded={!collapsed}
                onToggle={state.toggle}
                actions={
                  typeof section.actions === "function"
                    ? section.actions(state)
                    : section.actions
                }
              />
              <div
                aria-hidden={collapsed}
                inert={collapsed}
                className={cn(
                  "min-h-0 flex-1 overflow-hidden",
                  collapsed ? "pointer-events-none opacity-0" : "opacity-100",
                )}
              >
                {section.render(state)}
              </div>
            </ResizablePanel>
          </Fragment>
        );
      })}
    </ResizablePanelGroup>
  );
}

function SidebarSectionHeader({
  title,
  badge,
  description,
  expanded,
  onToggle,
  actions,
}: {
  title: ReactNode;
  badge?: ReactNode;
  description?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  actions?: ReactNode;
}) {
  return (
    <div
      style={{ height: SIDEBAR_SECTION_HEADER_HEIGHT }}
      className="group flex shrink-0 items-center border-b border-border/50 bg-sidebar px-1.5"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded px-0.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-primary/45"
      >
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={12}
          strokeWidth={2.1}
          className={cn(
            "shrink-0 text-muted-foreground",
            expanded ? "rotate-0" : "-rotate-90",
          )}
        />
        <span className="min-w-0 truncate text-[10.5px] font-semibold uppercase tracking-[0.12em] text-foreground/85">
          {title}
        </span>
        {badge !== undefined ? (
          <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full border border-border/60 px-1 text-[9px] font-semibold tabular-nums text-muted-foreground">
            {badge}
          </span>
        ) : null}
        {description ? (
          <span className="min-w-0 truncate text-[10px] font-normal normal-case tracking-normal text-muted-foreground/75">
            {description}
          </span>
        ) : null}
      </button>
      {actions ? (
        <div
          className={cn(
            "ml-1 flex shrink-0 items-center gap-0.5",
            expanded
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          )}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export function SidebarSectionAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className="size-5 cursor-pointer rounded text-muted-foreground hover:text-foreground disabled:cursor-not-allowed"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[10.5px]">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

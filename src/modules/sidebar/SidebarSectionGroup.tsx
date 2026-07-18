import { Button } from "@/components/ui/button";
import {
  animateResizableLayout,
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
import { Fragment, type ReactNode, useCallback, useRef, useState } from "react";
import type {
  Layout,
  LayoutChangedMeta,
  PanelImperativeHandle,
} from "react-resizable-panels";
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

function storageKey(id: string): string {
  return `sidebar:sections:${id}`;
}

export function SidebarSectionGroup({ id, sections, className }: Props) {
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
    new Set(
      Object.entries(initialLayout.sections)
        .filter(([, item]) => item.collapsed)
        .map(([sectionId]) => sectionId),
    ),
  );
  const [collapsedSections, setCollapsedSections] = useState(
    () => new Set(collapsedRef.current),
  );
  const groupElementRef = useRef<HTMLDivElement>(null);

  const persistLayout = useCallback(() => {
    const next: SidebarSectionLayout = { version: 1, sections: {} };
    for (const section of sections) {
      next.sections[section.id] = {
        size: sizesRef.current.get(section.id) ?? section.defaultSize,
        collapsed: collapsedRef.current.has(section.id),
      };
    }
    void setWorkspaceValue(storageKey(id), next);
  }, [id, sections]);

  const replaceCollapsedSections = useCallback((next: Set<string>) => {
    collapsedRef.current = next;
    setCollapsedSections((current) =>
      current.size === next.size &&
      [...current].every((sectionId) => next.has(sectionId))
        ? current
        : next,
    );
  }, []);

  const handleLayoutChanged = useCallback(() => {
    const nextCollapsed = new Set<string>();
    for (const section of sections) {
      const panel = panelRefs.current.get(section.id);
      if (!panel) continue;
      if (panel.isCollapsed()) nextCollapsed.add(section.id);
      else sizesRef.current.set(section.id, panel.getSize().inPixels);
    }
    replaceCollapsedSections(nextCollapsed);
    persistLayout();
  }, [persistLayout, replaceCollapsedSections, sections]);

  const handleUserLayoutChanged = useCallback(
    (_layout: Layout, meta: LayoutChangedMeta) => {
      if (meta.isUserInteraction) handleLayoutChanged();
    },
    [handleLayoutChanged],
  );

  const toggleSection = useCallback(
    (section: SidebarSectionDefinition) => {
      const panel = panelRefs.current.get(section.id);
      if (!panel) return;
      const wasCollapsed = collapsedRef.current.has(section.id);
      if (!wasCollapsed) {
        sizesRef.current.set(section.id, panel.getSize().inPixels);
      }
      const nextCollapsed = new Set(collapsedRef.current);
      if (wasCollapsed) nextCollapsed.delete(section.id);
      else nextCollapsed.add(section.id);
      replaceCollapsedSections(nextCollapsed);
      persistLayout();

      animateResizableLayout(groupElementRef.current, () => {
        if (wasCollapsed) {
          panel.resize(
            `${sizesRef.current.get(section.id) ?? section.defaultSize}px`,
          );
        } else panel.collapse();
      });
    },
    [persistLayout, replaceCollapsedSections],
  );

  return (
    <ResizablePanelGroup
      id={`sidebar-sections-${id}`}
      elementRef={groupElementRef}
      orientation="vertical"
      className={cn("min-h-0 flex-1", className)}
      onLayoutChanged={handleUserLayoutChanged}
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
                  "min-h-0 flex-1 overflow-hidden transition-opacity duration-pane ease-standard motion-reduce:transition-none",
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
            "shrink-0 text-muted-foreground transition-transform duration-pane ease-standard motion-reduce:transition-none",
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
            "ml-1 flex shrink-0 items-center gap-0.5 transition-opacity duration-feedback motion-reduce:transition-none",
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

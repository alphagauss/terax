/**
 * 本文件渲染主侧边栏 Activity Bar 和副侧边栏容器导航。
 * 两侧共享位置、显隐、拖放、溢出滚动和菜单配置，并使用项目 Tooltip 统一悬停反馈。
 */

import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/menu/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/controls/tooltip";
import { Button } from "@/components/controls/button";
import { cn } from "@/lib/utils";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import FullScreenIcon from "@hugeicons/core-free-icons/FullScreenIcon";
import MaximizeScreenIcon from "@hugeicons/core-free-icons/MaximizeScreenIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { type PointerEvent, type ReactNode, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  beginSidebarDrag,
  finishSidebarDrag,
  updateSidebarDrag,
  useSidebarDragSnapshot,
} from "./dragSession";
import type {
  ActivityBarPosition,
  ActivityBarSettings,
  ActivityBarSize,
  SidebarContainerDefinition,
  SidebarContainerId,
  SidebarLocation,
  SecondarySidebarMode,
} from "./types";

export const SIDEBAR_COMPOSITE_BAR_HEIGHT = 36;

const ACTIVITY_BAR_POSITIONS = ["default", "top", "bottom", "hidden"] as const;
const ACTIVITY_BAR_SIZES = ["default", "compact"] as const;

type NavigationConfigurationProps = {
  allContainers: readonly SidebarContainerDefinition[];
  activityBar: ActivityBarSettings;
  onToggleVisibility: (id: SidebarContainerId) => void;
  onPositionChange: (position: ActivityBarPosition) => void;
  onSizeChange: (size: ActivityBarSize) => void;
};

type SharedNavigationProps = NavigationConfigurationProps & {
  containers: readonly SidebarContainerDefinition[];
  activeId: SidebarContainerId | null;
  badges?: Partial<Record<SidebarContainerId, number>>;
  onActivate: (id: SidebarContainerId) => void;
  onMove: (
    id: SidebarContainerId,
    location: SidebarLocation,
    index: number,
  ) => void;
  onReset: (id: SidebarContainerId) => void;
};

type DragPointerState = {
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
};

type NavigationAppearance = "vertical" | "tabs" | "icons";

/** 为不同方向的导航提供隐藏滚动条、滚轮转换和活动项自动可见。 */
function NavigationViewport({
  orientation,
  activeId,
  itemIds,
  children,
  windowDragRegion,
}: {
  orientation: "horizontal" | "vertical";
  activeId: SidebarContainerId | null;
  itemIds: readonly SidebarContainerId[];
  children: ReactNode;
  windowDragRegion?: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const itemOrder = itemIds.join("\0");

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !activeId || !itemOrder) return;
    const active = Array.from(
      viewport.querySelectorAll<HTMLElement>("[data-sidebar-container-id]"),
    ).find((element) => element.dataset.sidebarContainerId === activeId);
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, itemOrder]);

  useEffect(() => {
    if (orientation !== "horizontal") return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      if (
        document.documentElement.dataset.sidebarDragging === "true" ||
        Math.abs(event.deltaY) <= Math.abs(event.deltaX) ||
        viewport.scrollWidth <= viewport.clientWidth
      ) {
        return;
      }
      event.preventDefault();
      viewport.scrollBy({
        left: event.deltaY,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [orientation]);

  return (
    <div
      ref={viewportRef}
      data-sidebar-navigation-viewport
      data-tauri-drag-region={windowDragRegion || undefined}
      className={cn(
        "overscroll-none scroll-smooth motion-reduce:scroll-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        orientation === "vertical"
          ? "min-h-0 w-full flex-1 overflow-x-hidden overflow-y-auto"
          : "min-w-0 flex-1 overflow-x-auto overflow-y-hidden",
      )}
    >
      <div
        data-tauri-drag-region={windowDragRegion || undefined}
        className={cn(
          "flex",
          orientation === "vertical"
            ? "min-h-full w-full flex-col items-center"
            : "w-max items-center gap-1",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function isActivityBarPosition(value: string): value is ActivityBarPosition {
  return ACTIVITY_BAR_POSITIONS.some((position) => position === value);
}

function isActivityBarSize(value: string): value is ActivityBarSize {
  return ACTIVITY_BAR_SIZES.some((size) => size === value);
}

function Badge({ value }: { value: number | undefined }) {
  if (!value || value <= 0) return null;
  return (
    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-sidebar-primary px-1 text-[9px] font-semibold leading-none tabular-nums text-white">
      {value > 99 ? "99+" : value}
    </span>
  );
}

/** 渲染拖放插入线，末尾间隙必须朝容器内部延伸以避免被裁剪。 */
function DropIndicator({
  orientation,
  end = false,
}: {
  orientation: "horizontal" | "vertical";
  end?: boolean;
}) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute z-20 bg-foreground",
        orientation === "vertical"
          ? end
            ? "-top-0.5 right-1 left-1 h-0.5"
            : "top-0 right-1 left-1 h-0.5"
          : end
            ? "top-1 bottom-1 -left-0.5 w-0.5"
            : "top-1 bottom-1 left-0 w-0.5",
      )}
    />
  );
}

function ActivityBarConfigurationMenu({
  allContainers,
  activityBar,
  onToggleVisibility,
  onPositionChange,
  onSizeChange,
}: NavigationConfigurationProps) {
  const { t } = useTranslation("sidebar");
  return (
    <>
      {allContainers.map((container) => (
        <ContextMenuCheckboxItem
          key={container.id}
          checked={!activityBar.hiddenContainerIds.includes(container.id)}
          onCheckedChange={() => onToggleVisibility(container.id)}
        >
          {t(container.titleKey)}
        </ContextMenuCheckboxItem>
      ))}
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          {t("activityBarPosition")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuRadioGroup
            value={activityBar.position}
            onValueChange={(value) => {
              if (isActivityBarPosition(value)) onPositionChange(value);
            }}
          >
            {ACTIVITY_BAR_POSITIONS.map((position) => (
              <ContextMenuRadioItem
                key={position}
                value={position}
              >
                {t(`position.${position}`)}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>
      {activityBar.position === "default" ? (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            {t("activityBarSize")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup
              value={activityBar.size}
              onValueChange={(value) => {
                if (isActivityBarSize(value)) onSizeChange(value);
              }}
            >
              {ACTIVITY_BAR_SIZES.map((size) => (
                <ContextMenuRadioItem
                  key={size}
                  value={size}
                >
                  {t(`size.${size}`)}
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
      ) : null}
    </>
  );
}

function ActivityBarMenu({
  children,
  ...configuration
}: NavigationConfigurationProps & { children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ActivityBarConfigurationMenu {...configuration} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ContainerMenu({
  container,
  location,
  hidden,
  onMove,
  onReset,
  onToggleVisibility,
  children,
}: {
  container: SidebarContainerDefinition;
  location: SidebarLocation;
  hidden: boolean;
  onMove: SharedNavigationProps["onMove"];
  onReset: SharedNavigationProps["onReset"];
  onToggleVisibility: SharedNavigationProps["onToggleVisibility"];
  children: ReactNode;
}) {
  const { t } = useTranslation("sidebar");
  return (
    <ContextMenu>
      <ContextMenuTrigger className="contents">{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem
          onSelect={() => onToggleVisibility(container.id)}
        >
          {t(hidden ? "showContainer" : "hideContainer", {
            name: t(container.titleKey),
          })}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={
            location === "primary" ||
            !container.allowedLocations.includes("primary")
          }
          onSelect={() =>
            onMove(container.id, "primary", Number.MAX_SAFE_INTEGER)
          }
        >
          {t("moveToPrimary")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={
            location === "secondary" ||
            !container.allowedLocations.includes("secondary")
          }
          onSelect={() =>
            onMove(container.id, "secondary", Number.MAX_SAFE_INTEGER)
          }
        >
          {t("moveToSecondary")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => onReset(container.id)}
        >
          {t("resetLocation")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function DraggableContainerButton({
  container,
  location,
  active,
  appearance,
  barPosition,
  className,
  onActivate,
  onMove,
  children,
}: {
  container: SidebarContainerDefinition;
  location: SidebarLocation;
  active: boolean;
  appearance: NavigationAppearance;
  barPosition: ActivityBarPosition;
  className: string;
  onActivate: SharedNavigationProps["onActivate"];
  onMove: SharedNavigationProps["onMove"];
  children: ReactNode;
}) {
  const { t } = useTranslation("sidebar");
  const pointerRef = useRef<DragPointerState | null>(null);
  const suppressClickRef = useRef(false);

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    if (
      !pointer.dragging &&
      Math.hypot(
        event.clientX - pointer.startX,
        event.clientY - pointer.startY,
      ) >= 5
    ) {
      pointer.dragging = true;
      beginSidebarDrag(
        container.id,
        location,
        container.allowedLocations,
        onMove,
        event.currentTarget,
      );
    }
    if (pointer.dragging) {
      event.preventDefault();
      updateSidebarDrag(event.clientX, event.clientY);
    }
  };

  const handlePointerEnd = (
    event: PointerEvent<HTMLButtonElement>,
    commit: boolean,
  ) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    pointerRef.current = null;
    if (!pointer.dragging) return;
    updateSidebarDrag(event.clientX, event.clientY);
    finishSidebarDrag(commit);
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const tooltipSide =
    appearance === "vertical"
      ? "right"
      : barPosition === "bottom"
        ? "top"
        : "bottom";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-sidebar-container-button={container.id}
          aria-label={t(container.titleKey)}
          aria-pressed={active}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={(event) => handlePointerEnd(event, true)}
          onPointerCancel={(event) => handlePointerEnd(event, false)}
          onLostPointerCapture={(event) => handlePointerEnd(event, false)}
          onClick={(event) => {
            if (suppressClickRef.current) {
              event.preventDefault();
              return;
            }
            onActivate(container.id);
          }}
          className={className}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side={tooltipSide}
        sideOffset={appearance === "vertical" ? 7 : 5}
      >
        {t(container.titleKey)}
      </TooltipContent>
    </Tooltip>
  );
}

function NavigationItems({
  location,
  appearance,
  barPosition,
  containers,
  activeId,
  activityBar,
  badges,
  onActivate,
  onMove,
  onReset,
  onToggleVisibility,
}: SharedNavigationProps & {
  location: SidebarLocation;
  appearance: NavigationAppearance;
  barPosition: ActivityBarPosition;
}) {
  const { t } = useTranslation("sidebar");
  const drag = useSidebarDragSnapshot();
  const orientation = appearance === "vertical" ? "vertical" : "horizontal";
  const compact = activityBar.size === "compact" && appearance === "vertical";

  return (
    <>
      {containers.map((container, index) => {
        const active = container.id === activeId;
        const showIndicator =
          drag.target?.location === location && drag.target.index === index;
        const iconOnly = appearance !== "tabs";
        return (
          <div
            key={container.id}
            data-sidebar-container-id={container.id}
            className="relative shrink-0"
          >
            {showIndicator ? <DropIndicator orientation={orientation} /> : null}
            <ContainerMenu
              container={container}
              location={location}
              hidden={activityBar.hiddenContainerIds.includes(container.id)}
              onMove={onMove}
              onReset={onReset}
              onToggleVisibility={onToggleVisibility}
            >
              <DraggableContainerButton
                container={container}
                location={location}
                active={active}
                appearance={appearance}
                barPosition={barPosition}
                onActivate={onActivate}
                onMove={onMove}
                className={cn(
                  "group relative flex cursor-pointer touch-none items-center rounded-md text-muted-foreground outline-none transition-colors duration-control focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none",
                  appearance === "vertical" &&
                    (compact
                      ? "h-7 w-9 justify-center"
                      : "h-12 w-11 justify-center"),
                  appearance === "icons" && "size-7 justify-center",
                  appearance === "tabs" &&
                    "h-7 max-w-44 justify-center gap-1.5 px-2.5 text-[11px] font-medium",
                  active
                    ? "text-foreground"
                    : "hover:bg-interactive-hover hover:text-foreground",
                )}
              >
                {active ? (
                  <span
                    className={cn(
                      "absolute bg-primary",
                      appearance === "vertical" &&
                        "top-0 bottom-0 left-0 w-0.5",
                      appearance === "tabs" &&
                        barPosition === "bottom" &&
                        "top-0.5 right-2.5 left-2.5 h-px",
                      appearance === "tabs" &&
                        barPosition !== "bottom" &&
                        "right-2.5 bottom-0.5 left-2.5 h-px",
                      appearance === "icons" &&
                        barPosition === "bottom" &&
                        "top-0.5 right-0.5 left-0.5 h-px",
                      appearance === "icons" &&
                        barPosition !== "bottom" &&
                        "right-0.5 bottom-0.5 left-0.5 h-px",
                    )}
                  />
                ) : null}
                <HugeiconsIcon
                  icon={container.icon}
                  size={appearance === "vertical" ? (compact ? 16 : 24) : 15}
                  strokeWidth={active ? 2 : 1.75}
                  className="shrink-0"
                />
                {appearance === "tabs" ? (
                  <>
                    <span className="min-w-0 truncate">
                      {t(container.titleKey)}
                    </span>
                    <Badge value={badges?.[container.id]} />
                  </>
                ) : null}
                {iconOnly ? (
                  <span className="absolute -top-0.5 right-0.5">
                    <Badge value={badges?.[container.id]} />
                  </span>
                ) : null}
              </DraggableContainerButton>
            </ContainerMenu>
          </div>
        );
      })}
      {drag.target?.location === location &&
      drag.target.index === containers.length ? (
        <div
          className={cn(
            "relative shrink-0 self-stretch",
            orientation === "vertical" ? "h-0" : "w-0",
          )}
        >
          <DropIndicator orientation={orientation} end />
        </div>
      ) : null}
    </>
  );
}

/** 渲染主侧边栏导航，空白区域复用标题栏的原生窗口交互。 */
export function SidebarActivityBar({
  activityBar,
  ...props
}: SharedNavigationProps) {
  if (activityBar.position === "hidden") return null;
  const vertical = activityBar.position === "default";
  const compact = activityBar.size === "compact" && vertical;
  const bar = vertical ? (
    <aside
      data-tauri-drag-region
      data-sidebar-drop-location="primary"
      data-sidebar-orientation="vertical"
      className={cn(
        "flex min-h-0 shrink-0 flex-col items-center border-r border-layout-divider bg-sidebar",
        compact ? "w-9" : "w-11",
      )}
    >
      <NavigationViewport
        windowDragRegion
        orientation="vertical"
        activeId={props.activeId}
        itemIds={props.containers.map((container) => container.id)}
      >
        <NavigationItems
          {...props}
          activityBar={activityBar}
          location="primary"
          appearance="vertical"
          barPosition="default"
        />
      </NavigationViewport>
    </aside>
  ) : (
    <div
      data-tauri-drag-region
      data-sidebar-drop-location="primary"
      data-sidebar-orientation="horizontal"
      style={{ height: SIDEBAR_COMPOSITE_BAR_HEIGHT }}
      className={cn(
        "flex shrink-0 items-center gap-1 bg-sidebar px-1.5 py-1",
        activityBar.position === "bottom"
          ? "border-t border-layout-divider"
          : "border-b border-layout-divider",
      )}
    >
      <NavigationViewport
        windowDragRegion
        orientation="horizontal"
        activeId={props.activeId}
        itemIds={props.containers.map((container) => container.id)}
      >
        <NavigationItems
          {...props}
          activityBar={activityBar}
          location="primary"
          appearance="icons"
          barPosition={activityBar.position}
        />
      </NavigationViewport>
    </div>
  );

  return (
    <TooltipProvider>
      <ActivityBarMenu {...props} activityBar={activityBar}>
        {bar}
      </ActivityBarMenu>
    </TooltipProvider>
  );
}

/** 渲染与 Activity Bar 位置联动的副侧边栏导航及展示、关闭操作。 */
export function SecondarySidebarTabs({
  onClose,
  onToggleMode,
  secondaryMode,
  activityBar,
  ...props
}: SharedNavigationProps & {
  onClose: () => void;
  onToggleMode: (mode: Exclude<SecondarySidebarMode, "normal">) => void;
  secondaryMode: SecondarySidebarMode;
}) {
  const { t } = useTranslation("sidebar");
  if (activityBar.position === "hidden") return null;
  const bottom = activityBar.position === "bottom";
  const appearance = activityBar.position === "default" ? "tabs" : "icons";
  const modeActions = [
    {
      mode: "expanded" as const,
      active: secondaryMode === "expanded",
      label:
        secondaryMode === "expanded" ? "restoreSecondary" : "expandSecondary",
      icon: MaximizeScreenIcon,
    },
    {
      mode: "maximized" as const,
      active: secondaryMode === "maximized",
      label:
        secondaryMode === "maximized"
          ? "restoreSecondary"
          : "maximizeSecondary",
      icon: FullScreenIcon,
    },
  ];
  const bar = (
    <div
      data-sidebar-drop-location="secondary"
      data-sidebar-orientation="horizontal"
      style={{ height: SIDEBAR_COMPOSITE_BAR_HEIGHT }}
      className={cn(
        "flex shrink-0 items-center gap-1 bg-sidebar px-1.5 py-1",
        bottom
          ? "border-t border-layout-divider"
          : "border-b border-layout-divider",
      )}
    >
      <NavigationViewport
        orientation="horizontal"
        activeId={props.activeId}
        itemIds={props.containers.map((container) => container.id)}
      >
        <NavigationItems
          {...props}
          activityBar={activityBar}
          location="secondary"
          appearance={appearance}
          barPosition={activityBar.position}
        />
      </NavigationViewport>
      {modeActions.map((action) => (
        <Tooltip key={action.mode}>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={action.active ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={() => onToggleMode(action.mode)}
              aria-label={t(action.label)}
              aria-pressed={action.active}
            >
              <HugeiconsIcon icon={action.icon} size={14} strokeWidth={1.8} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side={bottom ? "top" : "bottom"} sideOffset={5}>
            {t(action.label)}
          </TooltipContent>
        </Tooltip>
      ))}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t("closeSecondary")}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.8} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side={bottom ? "top" : "bottom"} sideOffset={5}>
          {t("closeSecondary")}
        </TooltipContent>
      </Tooltip>
    </div>
  );

  return (
    <TooltipProvider>
      <ActivityBarMenu {...props} activityBar={activityBar}>
        {bar}
      </ActivityBarMenu>
    </TooltipProvider>
  );
}

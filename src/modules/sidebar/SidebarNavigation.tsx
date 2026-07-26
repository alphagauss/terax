/**
 * 本文件渲染主侧边栏 Activity Bar 和副侧边栏容器导航。
 * 两侧共享位置、显隐、拖放和菜单配置，并使用项目 Tooltip 统一悬停反馈。
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
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type PointerEvent, type ReactNode, useRef } from "react";
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
} from "./types";

export const SIDEBAR_COMPOSITE_BAR_HEIGHT = 36;

const ACTIVITY_BAR_POSITIONS = ["default", "top", "bottom", "hidden"] as const;
const ACTIVITY_BAR_SIZES = ["default", "compact"] as const;
const COMPACT_MENU_CONTENT = "min-w-44 rounded-2xl p-1";
const COMPACT_MENU_ITEM = "gap-2 rounded-xl px-2.5 py-1.5 text-xs";
const COMPACT_MENU_CHECK_ITEM = "gap-2 rounded-xl py-1.5 pr-7 pl-2.5 text-xs";

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

function isActivityBarPosition(value: string): value is ActivityBarPosition {
  return ACTIVITY_BAR_POSITIONS.some((position) => position === value);
}

function isActivityBarSize(value: string): value is ActivityBarSize {
  return ACTIVITY_BAR_SIZES.some((size) => size === value);
}

function Badge({ value }: { value: number | undefined }) {
  if (!value || value <= 0) return null;
  return (
    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-border/60 bg-card px-1 text-[9px] font-semibold leading-none tabular-nums text-muted-foreground">
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
          className={COMPACT_MENU_CHECK_ITEM}
          checked={!activityBar.hiddenContainerIds.includes(container.id)}
          onCheckedChange={() => onToggleVisibility(container.id)}
        >
          {t(container.titleKey)}
        </ContextMenuCheckboxItem>
      ))}
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger className={COMPACT_MENU_ITEM}>
          {t("activityBarPosition")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className={COMPACT_MENU_CONTENT}>
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
                className={COMPACT_MENU_CHECK_ITEM}
              >
                {t(`position.${position}`)}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>
      {activityBar.position === "default" ? (
        <ContextMenuSub>
          <ContextMenuSubTrigger className={COMPACT_MENU_ITEM}>
            {t("activityBarSize")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className={COMPACT_MENU_CONTENT}>
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
                  className={COMPACT_MENU_CHECK_ITEM}
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
      <ContextMenuContent className={cn("w-52", COMPACT_MENU_CONTENT)}>
        <ActivityBarConfigurationMenu {...configuration} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ContainerMenu({
  container,
  location,
  onMove,
  onReset,
  onToggleVisibility,
  children,
}: {
  container: SidebarContainerDefinition;
  location: SidebarLocation;
  onMove: SharedNavigationProps["onMove"];
  onReset: SharedNavigationProps["onReset"];
  onToggleVisibility: SharedNavigationProps["onToggleVisibility"];
  children: ReactNode;
}) {
  const { t } = useTranslation("sidebar");
  return (
    <ContextMenu>
      <ContextMenuTrigger className="contents">{children}</ContextMenuTrigger>
      <ContextMenuContent className={cn("w-48", COMPACT_MENU_CONTENT)}>
        <ContextMenuItem
          className={COMPACT_MENU_ITEM}
          onSelect={() => onToggleVisibility(container.id)}
        >
          {t("hideContainer", { name: t(container.titleKey) })}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className={COMPACT_MENU_ITEM}
          disabled={location === "primary"}
          onSelect={() =>
            onMove(container.id, "primary", Number.MAX_SAFE_INTEGER)
          }
        >
          {t("moveToPrimary")}
        </ContextMenuItem>
        <ContextMenuItem
          className={COMPACT_MENU_ITEM}
          disabled={location === "secondary"}
          onSelect={() =>
            onMove(container.id, "secondary", Number.MAX_SAFE_INTEGER)
          }
        >
          {t("moveToSecondary")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className={COMPACT_MENU_ITEM}
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
      beginSidebarDrag(container.id, location, onMove, event.currentTarget);
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
        className="rounded-md border border-border/60 bg-popover px-2 py-1 text-[11px] font-medium text-popover-foreground shadow-lg"
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
                      : "size-12 justify-center"),
                  appearance === "icons" && "size-7 justify-center",
                  appearance === "tabs" &&
                    "h-7 max-w-44 justify-center gap-1.5 px-2.5 text-[11px] font-medium",
                  active
                    ? "text-foreground"
                    : "hover:bg-foreground/[0.045] hover:text-foreground",
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
                  <span className="absolute -top-0.5 -right-0.5">
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

/** 渲染主侧边栏的纵向或横向容器导航。 */
export function SidebarActivityBar({
  activityBar,
  ...props
}: SharedNavigationProps) {
  if (activityBar.position === "hidden") return null;
  const vertical = activityBar.position === "default";
  const compact = activityBar.size === "compact" && vertical;
  const bar = vertical ? (
    <aside
      data-sidebar-drop-location="primary"
      data-sidebar-orientation="vertical"
      className={cn(
        "flex shrink-0 flex-col items-center border-r border-border/60 bg-sidebar",
        compact ? "w-9" : "w-12",
      )}
    >
      <NavigationItems
        {...props}
        activityBar={activityBar}
        location="primary"
        appearance="vertical"
        barPosition="default"
      />
    </aside>
  ) : (
    <div
      data-sidebar-drop-location="primary"
      data-sidebar-orientation="horizontal"
      style={{ height: SIDEBAR_COMPOSITE_BAR_HEIGHT }}
      className={cn(
        "flex shrink-0 items-center gap-1 bg-sidebar px-1.5 py-1",
        activityBar.position === "bottom"
          ? "border-t border-border/60"
          : "border-b border-border/60",
      )}
    >
      <NavigationItems
        {...props}
        activityBar={activityBar}
        location="primary"
        appearance="icons"
        barPosition={activityBar.position}
      />
    </div>
  );

  return (
    <TooltipProvider delayDuration={450} skipDelayDuration={100}>
      <ActivityBarMenu {...props} activityBar={activityBar}>
        {bar}
      </ActivityBarMenu>
    </TooltipProvider>
  );
}

/** 渲染与 Activity Bar 位置联动的副侧边栏容器导航。 */
export function SecondarySidebarTabs({
  onClose,
  activityBar,
  ...props
}: SharedNavigationProps & { onClose: () => void }) {
  const { t } = useTranslation("sidebar");
  if (activityBar.position === "hidden") return null;
  const bottom = activityBar.position === "bottom";
  const appearance = activityBar.position === "default" ? "tabs" : "icons";
  const bar = (
    <div
      data-sidebar-drop-location="secondary"
      data-sidebar-orientation="horizontal"
      style={{ height: SIDEBAR_COMPOSITE_BAR_HEIGHT }}
      className={cn(
        "flex shrink-0 items-center gap-1 bg-sidebar px-1.5 py-1",
        bottom ? "border-t border-border/60" : "border-b border-border/60",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        <NavigationItems
          {...props}
          activityBar={activityBar}
          location="secondary"
          appearance={appearance}
          barPosition={activityBar.position}
        />
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClose}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-control hover:bg-foreground/[0.045] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
            aria-label={t("closeSecondary")}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.8} />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side={bottom ? "top" : "bottom"}
          sideOffset={5}
          className="rounded-md border border-border/60 bg-popover px-2 py-1 text-[11px] font-medium text-popover-foreground shadow-lg"
        >
          {t("closeSecondary")}
        </TooltipContent>
      </Tooltip>
    </div>
  );

  return (
    <TooltipProvider delayDuration={450} skipDelayDuration={100}>
      <ActivityBarMenu {...props} activityBar={activityBar}>
        {bar}
      </ActivityBarMenu>
    </TooltipProvider>
  );
}

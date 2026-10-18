/**
 * 本文件实现 Workbench 标签栏及其标签操作菜单。
 * 负责标签切换、拖拽和新建入口展示，菜单内容必须在不同语言和快捷键长度下保持可读。
 */

import { Hint } from "@/components/controls/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/menu/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import { Button } from "@/components/controls/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  copyToClipboard,
  relativePath,
  revealInFinder,
} from "@/modules/explorer/lib/contextActions";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import { isPythonFile } from "@/modules/python/path";
import { useRemoteRuntimeStore } from "@/modules/remote";
import { useShortcutLabel } from "@/modules/shortcuts";
import {
  beginWorkbenchDrag,
  finishWorkbenchDrag,
  updateWorkbenchDrag,
  useWorkbenchDragSnapshot,
  type WorkbenchDropTarget,
} from "@/modules/workbench/dragSession";
import type { Tab, WorkbenchDirection } from "@/modules/workbench/types";
import type { WorkspacePageHandoffMenuActions } from "@/modules/workspace-handoff";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { workspacePageFromTab } from "@/modules/workspace-handoff";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import ComputerTerminal02Icon from "@hugeicons/core-free-icons/ComputerTerminal02Icon";
import GitCompareIcon from "@hugeicons/core-free-icons/GitCompareIcon";
import Globe02Icon from "@hugeicons/core-free-icons/Globe02Icon";
import IncognitoIcon from "@hugeicons/core-free-icons/IncognitoIcon";
import PencilEdit02Icon from "@hugeicons/core-free-icons/PencilEdit02Icon";
import PlusSignIcon from "@hugeicons/core-free-icons/PlusSignIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { filePathFor, labelFor } from "@/modules/tabs/lib/tabLabel";

type Props = {
  groupId: number;
  tabs: Tab[];
  activeId: number;
  activeGroup: boolean;
  onSelect: (id: number) => void;
  onNew: () => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewWebPreview: () => void;
  onNewEditor: () => void;
  onClose: (id: number) => void;
  onRunPythonFile: (id: number, groupId: number) => void;
  onAttachFileToAgent: (path: string) => void;
  /** Pin (promote) a preview tab to persistent on double-click. */
  onPin: (id: number) => void;
  /** Set a terminal tab's custom label; empty string resets to default. */
  onRename: (id: number, title: string) => void;
  onDropTab: (tabId: number, target: WorkbenchDropTarget) => void;
  onSplitTab: (
    tabId: number,
    direction: WorkbenchDirection,
    move: boolean,
  ) => void;
  canClose: boolean;
  pageHandoff?: WorkspacePageHandoffMenuActions;
  compact?: boolean;
};

/**
 * Workbench 标签栏组件。
 *
 * 负责标签展示和交互入口，并在活动标签上呈现最终 SSH 断开状态。
 * 新建 Tab 菜单为名称与快捷键预留稳定宽度，并禁止单项内容折行。
 */
export function TabBar({
  groupId,
  tabs,
  activeId,
  activeGroup,
  onSelect,
  onNew,
  onNewBlock,
  onNewPrivate,
  onNewWebPreview,
  onNewEditor,
  onClose,
  onRunPythonFile,
  onAttachFileToAgent,
  onPin,
  onRename,
  onDropTab,
  onSplitTab,
  canClose,
  pageHandoff,
  compact,
}: Props) {
  const { t: tr } = useTranslation("tabs");
  const workspace = currentWorkspaceEnv();
  const sshDisconnected = useRemoteRuntimeStore((state) => {
    const runtime = state.snapshot;
    return (
      workspace.kind === "ssh" &&
      runtime.phase === "disconnected" &&
      runtime.profileId === workspace.profileId
    );
  });
  const newTerminalShortcut = useShortcutLabel("tab.new");
  const newBlockShortcut = useShortcutLabel("tab.newBlock");
  const newPrivateShortcut = useShortcutLabel("tab.newPrivate");
  const newEditorShortcut = useShortcutLabel("tab.newEditor");
  const newWebPreviewShortcut = useShortcutLabel("tab.newWebPreview");
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const dragSnapshot = useWorkbenchDragSnapshot();
  const dropGap =
    dragSnapshot.target?.kind === "tabs" &&
    dragSnapshot.target.groupId === groupId
      ? dragSnapshot.target.gap
      : null;
  const draggedTabId =
    dragSnapshot.payload?.kind === "tab"
      ? dragSnapshot.payload.tabId
      : draggingId;
  const dragActive = dragSnapshot.payload !== null || draggingId !== null;
  const draggedTabIndex =
    draggedTabId === null
      ? -1
      : tabs.findIndex((tab) => tab.id === draggedTabId);
  const showDropGap = (gap: number) =>
    dragActive &&
    dropGap === gap &&
    (draggedTabIndex < 0 ||
      (gap !== draggedTabIndex && gap !== draggedTabIndex + 1));
  const dropTabRef = useRef(onDropTab);
  dropTabRef.current = onDropTab;
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    fromId: number;
    active: boolean;
  } | null>(null);

  // Play the enter animation only for tabs opened after the first paint, never
  // the restored set and never on switch/reorder (triggers are keyed, so they
  // don't remount then). The ref is seeded with the initial ids on first render.
  const seenRef = useRef<Set<number> | null>(null);
  const firstRender = seenRef.current === null;
  let seen = seenRef.current;
  if (seen === null) {
    seen = new Set(tabs.map((t) => t.id));
    seenRef.current = seen;
  }
  useEffect(() => {
    seenRef.current = new Set(tabs.map((t) => t.id));
  }, [tabs]);

  // Single shared pill slides to the active tab instead of each tab toggling
  // its own background. Measured relative to the list (its offsetParent) so it
  // scrolls with the strip for free; transform/width only, no layout on siblings.
  const [pill, setPill] = useState<{ left: number; width: number } | null>(
    null,
  );
  const [pillReady, setPillReady] = useState(false);

  const measurePill = useCallback(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      '[data-tab-active="true"]',
    );
    setPill(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
  }, []);

  useLayoutEffect(() => {
    void activeId;
    void tabs;
    measurePill();
  }, [measurePill, activeId, tabs]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const ro = new ResizeObserver(measurePill);
    ro.observe(list);
    return () => ro.disconnect();
  }, [measurePill]);

  // Hold the transition off until the pill is first placed, so it never slides
  // in from the origin on mount.
  useEffect(() => {
    if (pill && !pillReady) {
      const id = requestAnimationFrame(() => setPillReady(true));
      return () => cancelAnimationFrame(id);
    }
  }, [pill, pillReady]);

  const endDrag = (currentTarget: HTMLElement) => {
    const st = drag.current;
    if (st) currentTarget.releasePointerCapture?.(st.pointerId);
    drag.current = null;
    setDraggingId(null);
    document.body.style.userSelect = "";
  };

  // Horizontal wheel scroll without holding shift.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      if (el.scrollWidth > el.clientWidth) {
        el.scrollBy({ left: e.deltaY, behavior: "smooth" });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the active tab visible after selection / open.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`);
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  return (
    <div
      ref={scrollRef}
      data-workbench-tabbar={groupId}
      className="min-w-0 flex-1 scroll-smooth overflow-x-auto overflow-y-hidden overscroll-none [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="flex w-max items-center gap-0.5">
        <Tabs
          value={String(activeId)}
          onValueChange={(v) => onSelect(Number(v))}
        >
          <TabsList
            ref={listRef}
            className="relative h-7 w-max gap-0.5 bg-transparent p-0"
          >
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute left-0 top-1/2 h-7 rounded-md bg-interactive-active shadow-sm ring-1 ring-inset",
                activeGroup ? "ring-primary/60" : "ring-foreground/[0.05]",
              )}
              style={
                pill
                  ? {
                      width: pill.width,
                      transform: `translate(${pill.left}px, -50%)`,
                      transitionProperty: pillReady
                        ? "transform, width"
                        : "none",
                      transitionDuration: "var(--dur-control)",
                      transitionTimingFunction: "var(--ease-emphasized)",
                    }
                  : { opacity: 0 }
              }
            />
            {tabs.map((t, i) => {
              const isPreview =
                (t.kind === "editor" ||
                  t.kind === "markdown" ||
                  t.kind === "git-diff" ||
                  t.kind === "git-commit-file") &&
                t.preview;
              const isActive = t.id === activeId;
              const isNew = !firstRender && !seen.has(t.id);
              const dirty =
                (t.kind === "editor" || t.kind === "markdown") && t.dirty;
              const connectionAlert =
                sshDisconnected && activeGroup && isActive;

              // While renaming, render a non-button cell so the <input> is not
              // nested inside the trigger <button> (invalid HTML, and WebKit
              // blocks focus/selection on inputs inside buttons).
              if (editingId === t.id && t.kind === "terminal") {
                return (
                  <Fragment key={t.id}>
                    {showDropGap(i) && <DropIndicator />}
                    <div
                      data-tab-id={t.id}
                      className={cn(
                        "flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-interactive-active text-xs text-foreground",
                        compact ? "px-1.5" : "px-2",
                      )}
                    >
                      <TabIcon tab={t} />
                      <TabRenameInput
                        initial={labelFor(t)}
                        onCommit={(value) => {
                          onRename(t.id, value);
                          setEditingId(null);
                        }}
                        onCancel={() => setEditingId(null)}
                      />
                    </div>
                    {i === tabs.length - 1 && showDropGap(tabs.length) && (
                      <DropIndicator />
                    )}
                  </Fragment>
                );
              }

              const filePath = filePathFor(t);
              const fileRelativePath =
                (t.kind === "editor" || t.kind === "markdown") && t.explorerRoot
                  ? relativePath(t.explorerRoot, t.path)
                  : undefined;
              const trigger = (
                <TabsTrigger
                  value={String(t.id)}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    if ((e.target as HTMLElement).closest("[data-no-drag]"))
                      return;
                    drag.current = {
                      pointerId: e.pointerId,
                      startX: e.clientX,
                      startY: e.clientY,
                      fromId: t.id,
                      active: false,
                    };
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    const st = drag.current;
                    if (!st || st.pointerId !== e.pointerId) return;
                    if (!st.active) {
                      if (
                        Math.hypot(
                          e.clientX - st.startX,
                          e.clientY - st.startY,
                        ) < 4
                      ) {
                        return;
                      }
                      st.active = true;
                      setDraggingId(st.fromId);
                      document.body.style.userSelect = "none";
                      beginWorkbenchDrag(
                        { kind: "tab", tabId: st.fromId },
                        (payload, target) => {
                          if (payload.kind === "tab") {
                            dropTabRef.current(payload.tabId, target);
                          }
                        },
                      );
                    }
                    e.preventDefault();
                    updateWorkbenchDrag(e.clientX, e.clientY);
                  }}
                  onPointerUp={(e) => {
                    const st = drag.current;
                    if (st?.active) finishWorkbenchDrag(true);
                    else if (st) {
                      onSelect(t.id);
                    }
                    endDrag(e.currentTarget);
                  }}
                  onPointerCancel={(e) => {
                    finishWorkbenchDrag(false);
                    endDrag(e.currentTarget);
                  }}
                  onDoubleClick={() => isPreview && onPin(t.id)}
                  onAuxClick={(e) => {
                    if (e.button === 1 && canClose) {
                      e.preventDefault();
                      e.stopPropagation();
                      onClose(t.id);
                    }
                  }}
                  // Suppress Radix's switch-on-mousedown so a tab grabbed to
                  // drag (or a plain click) only activates on release.
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      return;
                    }
                    if (
                      e.button === 0 &&
                      !(e.target as HTMLElement).closest("[data-no-drag]")
                    ) {
                      e.preventDefault();
                    }
                  }}
                  className={cn(
                    "group relative z-[1] h-7 flex-none justify-between gap-1.5 rounded-md bg-transparent text-xs transition-colors data-active:bg-transparent dark:data-active:bg-transparent",
                    isNew && "terax-tab-in",
                    isActive
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                    draggingId === t.id && "opacity-50",
                    compact
                      ? canClose
                        ? "ps-1.5! pe-6!"
                        : "px-1.5!"
                      : canClose
                        ? "ps-2! pe-6!"
                        : "px-2!",
                  )}
                >
                  <span
                    className={cn(
                      "flex min-w-0 items-center gap-1.5",
                      compact ? "max-w-48" : "max-w-80",
                    )}
                  >
                    <TabIcon tab={t} />
                    {/* Preview tabs use italic to signal the transient state,
                        matching the visual convention from VSCode. */}
                    <Hint content={filePath}>
                      <span className={cn("truncate", isPreview && "italic")}>
                        {labelFor(t)}
                      </span>
                    </Hint>
                    {dirty || connectionAlert ? (
                      <Hint
                        content={
                          connectionAlert ? tr("sshDisconnected") : undefined
                        }
                      >
                        <span
                          role="img"
                          aria-label={tr(
                            dirty && connectionAlert
                              ? "unsavedAndSshDisconnected"
                              : connectionAlert
                                ? "sshDisconnected"
                                : "unsavedChanges",
                          )}
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            connectionAlert
                              ? "bg-destructive"
                              : "bg-foreground/70",
                          )}
                        />
                      </Hint>
                    ) : null}
                  </span>
                </TabsTrigger>
              );

              const tabCell = (
                <div
                  data-tab-id={t.id}
                  data-tab-active={isActive ? "true" : undefined}
                  className="group relative flex h-7 shrink-0 items-stretch"
                >
                  {trigger}
                  {canClose && (
                    <button
                      type="button"
                      aria-label={tr("closeTab")}
                      data-no-drag
                      onPointerDown={(event) => {
                        event.stopPropagation();
                      }}
                      onPointerUp={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onClose(t.id);
                      }}
                      className="absolute right-1 top-1/2 z-[2] -translate-y-1/2 rounded p-0.5 opacity-0 transition-opacity hover:bg-accent hover:opacity-100 group-hover:opacity-60 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <HugeiconsIcon
                        icon={Cancel01Icon}
                        size={11}
                        strokeWidth={2}
                      />
                    </button>
                  )}
                </div>
              );

              const canCopySplit = t.kind !== "ai-diff";
              const handoffPage = workspacePageFromTab(t);
              const tabNode = (
                <ContextMenu
                  onOpenChange={(open) => {
                    if (
                      open &&
                      pageHandoff?.enabled &&
                      typeof handoffPage === "object"
                    ) {
                      pageHandoff.refreshTargets();
                    }
                  }}
                >
                  <ContextMenuTrigger asChild>{tabCell}</ContextMenuTrigger>
                  <ContextMenuContent
                    className="min-w-48 p-1"
                    onCloseAutoFocus={(e) => e.preventDefault()}
                  >
                    {filePath && (
                      <>
                        {workspace.kind === "local" && (
                          <ContextMenuItem
                            className="rounded-xl px-2.5 py-1.5 text-[13px]"
                            onSelect={() => void revealInFinder(filePath)}
                          >
                            {tr("common:fileActions.reveal")}
                          </ContextMenuItem>
                        )}
                        {workspace.kind === "local" && <ContextMenuSeparator />}
                        <ContextMenuItem
                          className="rounded-xl px-2.5 py-1.5 text-[13px]"
                          onSelect={() => void copyToClipboard(filePath)}
                        >
                          {tr("explorer:menu.copyPath")}
                        </ContextMenuItem>
                        <ContextMenuItem
                          disabled={!fileRelativePath}
                          className="rounded-xl px-2.5 py-1.5 text-[13px]"
                          onSelect={() => {
                            if (fileRelativePath) {
                              void copyToClipboard(fileRelativePath);
                            }
                          }}
                        >
                          {tr("explorer:menu.copyRelativePath")}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        {t.kind === "editor" && isPythonFile(t.path) && (
                          <ContextMenuItem
                            className="rounded-xl px-2.5 py-1.5 text-[13px]"
                            onSelect={() => onRunPythonFile(t.id, groupId)}
                          >
                            {tr("runPythonFile")}
                          </ContextMenuItem>
                        )}
                        <ContextMenuItem
                          className="rounded-xl px-2.5 py-1.5 text-[13px]"
                          onSelect={() => onAttachFileToAgent(filePath)}
                        >
                          {tr("explorer:menu.attachToAgent")}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                      </>
                    )}
                    {t.kind === "terminal" && (
                      <ContextMenuItem
                        className="gap-2 rounded-xl px-2.5 py-1.5 text-[13px]"
                        onSelect={() => setEditingId(t.id)}
                      >
                        <HugeiconsIcon
                          icon={PencilEdit02Icon}
                          size={13}
                          strokeWidth={1.75}
                        />
                        <span className="flex-1">{tr("common:rename")}</span>
                      </ContextMenuItem>
                    )}
                    {t.kind === "terminal" && <ContextMenuSeparator />}
                    <ContextMenuItem
                      disabled={!canCopySplit}
                      className="rounded-xl px-2.5 py-1.5 text-[13px]"
                      onSelect={() => onSplitTab(t.id, "right", false)}
                    >
                      {tr("splitRight")}
                    </ContextMenuItem>
                    <ContextMenuSub>
                      <ContextMenuSubTrigger className="rounded-xl px-2.5 py-1.5 text-[13px]">
                        {tr("splitAndMove")}
                      </ContextMenuSubTrigger>
                      <ContextMenuSubContent className="min-w-36 p-1">
                        {(["up", "down", "left", "right"] as const).map(
                          (direction) => (
                            <ContextMenuItem
                              key={direction}
                              disabled={tabs.length === 1}
                              className="rounded-xl px-2.5 py-1.5 text-[13px]"
                              onSelect={() => onSplitTab(t.id, direction, true)}
                            >
                              {tr(`splitMove.${direction}`)}
                            </ContextMenuItem>
                          ),
                        )}
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                    {pageHandoff && (
                      <>
                        <ContextMenuSeparator />
                        {!pageHandoff.enabled ? (
                          <ContextMenuItem disabled>
                            {tr("multiWindowRequired")}
                          </ContextMenuItem>
                        ) : handoffPage === "dirty" ? (
                          <ContextMenuItem disabled>
                            {tr("saveBeforeWindowCopy")}
                          </ContextMenuItem>
                        ) : handoffPage === "unsupported" ? (
                          <ContextMenuItem disabled>
                            {tr("windowCopyUnsupported")}
                          </ContextMenuItem>
                        ) : (
                          <>
                            {pageHandoff.targets.length > 0 && (
                              <ContextMenuSub>
                                <ContextMenuSubTrigger>
                                  {tr("copyToTemporaryWindow")}
                                </ContextMenuSubTrigger>
                                <ContextMenuSubContent className="min-w-52">
                                  {pageHandoff.targets.map((target, index) => (
                                    <ContextMenuItem
                                      key={target.id}
                                      onSelect={() =>
                                        pageHandoff.copyToWindow(
                                          t.id,
                                          target.id,
                                        )
                                      }
                                    >
                                      {tr("temporaryWindowLabel", {
                                        index: index + 1,
                                        id: target.id.slice(0, 8),
                                      })}
                                    </ContextMenuItem>
                                  ))}
                                </ContextMenuSubContent>
                              </ContextMenuSub>
                            )}
                            <ContextMenuItem
                              onSelect={() => pageHandoff.copyToNewWindow(t.id)}
                            >
                              {tr("copyToNewTemporaryWindow")}
                            </ContextMenuItem>
                          </>
                        )}
                      </>
                    )}
                    {canClose && (
                      <>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          className="gap-2 rounded-xl px-2.5 py-1.5 text-[13px]"
                          onSelect={() => onClose(t.id)}
                        >
                          <HugeiconsIcon
                            icon={Cancel01Icon}
                            size={13}
                            strokeWidth={1.75}
                          />
                          <span className="flex-1">{tr("common:close")}</span>
                        </ContextMenuItem>
                      </>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              );

              return (
                <Fragment key={t.id}>
                  {showDropGap(i) && <DropIndicator />}
                  {tabNode}
                  {i === tabs.length - 1 && showDropGap(tabs.length) && (
                    <DropIndicator />
                  )}
                </Fragment>
              );
            })}
          </TabsList>
        </Tabs>
        {/* 正常宽度下跟随标签，横向溢出时吸附在滚动视口右侧。 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Hint content={tr("newTab")}>
              <Button
                aria-label={tr("newTab")}
                variant="ghost"
                size="icon-sm"
                className="sticky right-0 z-10 shrink-0 bg-card"
              >
                <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={2} />
              </Button>
            </Hint>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="min-w-56"
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <DropdownMenuItem onSelect={() => onNew()}>
              <HugeiconsIcon
                icon={ComputerTerminal02Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1 whitespace-nowrap">
                {tr("terminal")}
              </span>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                {newTerminalShortcut}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewBlock()}>
              <HugeiconsIcon
                icon={ComputerTerminal02Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1 whitespace-nowrap">
                {tr("blocks")}
              </span>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                {newBlockShortcut}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewPrivate()}>
              <HugeiconsIcon
                icon={IncognitoIcon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1 whitespace-nowrap">
                {tr("privacy")}
              </span>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                {newPrivateShortcut}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewEditor()}>
              <HugeiconsIcon
                icon={PencilEdit02Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1 whitespace-nowrap">
                {tr("editor")}
              </span>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                {newEditorShortcut}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewWebPreview()}>
              <HugeiconsIcon icon={Globe02Icon} size={14} strokeWidth={1.75} />
              <span className="min-w-0 flex-1 whitespace-nowrap">
                {tr("webPreview")}
              </span>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                {newWebPreviewShortcut}
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function DropIndicator() {
  return (
    <span
      aria-hidden
      className="my-0.5 w-0.5 shrink-0 self-stretch rounded-full bg-primary"
    />
  );
}

export function TabIcon({ tab }: { tab: Tab }) {
  if (tab.kind === "editor" || tab.kind === "markdown") {
    const url = fileIconUrl(tab.title);
    return url ? (
      <img
        src={url}
        alt=""
        className="size-3.5 shrink-0 object-contain"
        onError={(e) => {
          const img = e.currentTarget;
          if (img.dataset.fallback) return;
          img.dataset.fallback = "1";
          img.src = fileIconUrl("dummy.txt");
        }}
      />
    ) : null;
  }
  if (tab.kind === "web-preview") {
    return (
      <HugeiconsIcon
        icon={Globe02Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "ai-diff" || tab.kind === "file-edits") {
    return (
      <HugeiconsIcon
        icon={GitCompareIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "terminal" && tab.private) {
    return (
      <HugeiconsIcon
        icon={IncognitoIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "git-diff" || tab.kind === "git-commit-file") {
    return (
      <HugeiconsIcon
        icon={GitCompareIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={ComputerTerminal02Icon}
      size={14}
      strokeWidth={2}
      className="shrink-0"
    />
  );
}

function TabRenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const { t: tr } = useTranslation("tabs");
  const ref = useRef<HTMLInputElement>(null);
  // Guards against a trailing blur re-resolving an edit that Enter/Escape
  // already finished (Escape must never commit).
  const done = useRef(false);

  useEffect(() => {
    // Focus on the next frame so it runs after the context menu restores focus
    // to its trigger when closing; a synchronous focus would be stolen.
    const raf = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };

  // explicit = the user pressed Enter, which pins even the unchanged label. A
  // plain blur with no change must not freeze the cwd-derived default into a
  // custom title.
  const commit = (value: string, explicit: boolean) => {
    if (!explicit && value.trim() === initial.trim()) finish(onCancel);
    else finish(() => onCommit(value));
  };

  return (
    <input
      ref={ref}
      defaultValue={initial}
      aria-label={tr("renameTab")}
      className={cn(
        "w-28 min-w-0 rounded-sm bg-background px-1 text-xs text-foreground",
        "outline-none ring-1 ring-border focus:ring-ring",
      )}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit(e.currentTarget.value, true);
        else if (e.key === "Escape") finish(onCancel);
      }}
      onBlur={(e) => {
        // Switching windows/apps blurs the input; keep the edit open instead
        // of resolving it on the way out.
        if (!document.hasFocus()) return;
        commit(e.currentTarget.value, false);
      }}
    />
  );
}

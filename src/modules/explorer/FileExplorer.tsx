/**
 * 本文件实现工作区文件资源管理器。
 * 负责文件树、搜索、常规文件操作和非本地 Workspace 的后台传输入口。
 * Workspace 根目录选择仍由上层仅在 Local 环境传入。
 */

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import type { GitStatusSnapshot } from "@/modules/ai/lib/native";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useGlobalShortcuts } from "@/modules/shortcuts";
import {
  pickDownloadDirectory,
  pickUploadFiles,
  pickUploadFolders,
} from "@/modules/transfers/dialogs";
import { formatTransferError } from "@/modules/transfers/errors";
import { transferNative } from "@/modules/transfers/native";
import type { TransferStrategy } from "@/modules/transfers/types";
import type { WorkbenchDropTarget } from "@/modules/workbench/dragSession";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import {
  FileAddIcon,
  Folder01Icon,
  FolderAddIcon,
  FolderOpenIcon,
  ListChevronsDownUpIcon,
  Refresh01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ExplorerSearch, type ExplorerSearchHandle } from "./ExplorerSearch";
import { InlineInput } from "./InlineInput";
import {
  copyToClipboard,
  relativePath,
  revealInFinder,
} from "./lib/contextActions";
import type { GitStatusCode } from "./lib/gitStatusUtils";
import { fileIconUrl, folderIconUrl } from "./lib/iconResolver";
import { COMPACT_CONTENT, COMPACT_ITEM } from "./lib/menuItemClass";
import { useExplorerDnd } from "./lib/useExplorerDnd";
import { useExplorerFileDrop } from "./lib/useExplorerFileDrop";
import { ancestorDirs, useFileTree } from "./lib/useFileTree";
import { useGitStatus } from "./lib/useGitStatus";
import { EntryRow, PendingRow, type RowActions, StatusRow } from "./TreeRow";

export type FileExplorerHandle = {
  focus: () => void;
  isFocused: () => boolean;
  focusSearch: () => void;
  collapseAll: () => void;
};

/** 在 WSL 与 SSH 菜单中要求用户明确选择 Direct 或 Archive。 */
function TransferStrategyMenu({
  label,
  onSelect,
}: {
  label: string;
  onSelect: (strategy: TransferStrategy) => void;
}) {
  const { t } = useTranslation("explorer");
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger className={COMPACT_ITEM}>
        {label}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className={COMPACT_CONTENT}>
        {(["direct", "archive"] as const).map((strategy) => (
          <ContextMenuItem
            key={strategy}
            className={COMPACT_ITEM}
            onSelect={() => onSelect(strategy)}
          >
            {t(
              strategy === "direct"
                ? "menu.directTransfer"
                : "menu.archiveTransfer",
            )}
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

type Props = {
  rootPath: string | null;
  onOpenFolder?: () => void;
  activeFilePath?: string | null;
  onOpenFile: (path: string, pin?: boolean) => void;
  onPathRenamed?: (from: string, to: string) => void;
  onPathDeleted?: (path: string) => void;
  onRevealInTerminal?: (path: string) => void;
  onAttachToAgent?: (path: string) => void;
  onDropToWorkbench?: (path: string, target: WorkbenchDropTarget) => void;
  gitStatus?: GitStatusSnapshot | null;
};

type Row =
  | {
      kind: "entry";
      key: string;
      path: string;
      name: string;
      isDir: boolean;
      isExpanded: boolean;
      depth: number;
      gitignored: boolean;
      gitStatusCode: GitStatusCode | null;
    }
  | {
      kind: "rename";
      key: string;
      path: string;
      name: string;
      isDir: boolean;
      depth: number;
      gitignored: boolean;
      gitStatusCode: GitStatusCode | null;
    }
  | { kind: "pending"; key: string; depth: number; pendingKind: "file" | "dir" }
  | {
      kind: "status";
      key: string;
      depth: number;
      tone: "muted" | "error";
      message: string;
    };

type EntryTarget = {
  path: string;
  name: string;
  isDir: boolean;
};

const ROW_HEIGHT = 24;
const OVERSCAN = 8;

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function parentOf(path: string, fallback: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : fallback;
}

function buildRows(
  rootPath: string,
  tree: ReturnType<typeof useFileTree>,
  lookup: (path: string) => GitStatusCode | null,
  loadingLabel: string,
): { rows: Row[]; entryIndexByPath: Map<string, number> } {
  const rows: Row[] = [];
  const entryIndexByPath = new Map<string, number>();

  const walk = (parent: string, depth: number, parentIgnored: boolean) => {
    const node = tree.nodes[parent];
    if (!node || node.status !== "loaded") return;
    for (const entry of node.entries) {
      const path = tree.joinPath(parent, entry.name);
      const isDir = entry.kind === "dir";
      const expanded = isDir && tree.expanded.has(path);
      const isRenaming = tree.renaming === path;
      const gitignored = parentIgnored || entry.gitignored;
      const gitStatusCode = gitignored ? null : lookup(path);
      if (isRenaming) {
        rows.push({
          kind: "rename",
          key: `rename:${path}`,
          path,
          name: entry.name,
          isDir,
          depth,
          gitignored,
          gitStatusCode,
        });
      } else {
        entryIndexByPath.set(path, rows.length);
        rows.push({
          kind: "entry",
          key: path,
          path,
          name: entry.name,
          isDir,
          isExpanded: expanded,
          depth,
          gitignored,
          gitStatusCode,
        });
      }
      if (isDir && expanded) {
        const child = tree.nodes[path];
        if (tree.pendingCreate?.parentPath === path) {
          rows.push({
            kind: "pending",
            key: `pending:${path}`,
            depth: depth + 1,
            pendingKind: tree.pendingCreate.kind,
          });
        }
        if (child?.status === "loading") {
          rows.push({
            kind: "status",
            key: `loading:${path}`,
            depth: depth + 1,
            tone: "muted",
            message: loadingLabel,
          });
        } else if (child?.status === "error") {
          rows.push({
            kind: "status",
            key: `error:${path}`,
            depth: depth + 1,
            tone: "error",
            message: child.message,
          });
        } else if (child?.status === "loaded") {
          walk(path, depth + 1, gitignored);
        }
      }
    }
  };

  walk(rootPath, 0, false);
  return { rows, entryIndexByPath };
}

/**
 * 文件资源管理器组件。
 *
 * 展示当前终端驱动的目录树，并按运行环境提供本地根目录选择或后台传输操作。
 */
export const FileExplorer = memo(
  forwardRef<FileExplorerHandle, Props>(function FileExplorer(
    {
      rootPath,
      onOpenFolder,
      activeFilePath,
      onOpenFile,
      onPathRenamed,
      onPathDeleted,
      onRevealInTerminal,
      onAttachToAgent,
      onDropToWorkbench,
      gitStatus,
    },
    ref,
  ) {
    const { t } = useTranslation(["explorer", "statusbar"]);
    const tree = useFileTree(rootPath, { onPathRenamed, onPathDeleted });
    const workspaceEnv = useWorkspaceEnvStore((state) => state.env);

    /** 通过原生选择器创建文件或文件夹后台上传任务。 */
    const enqueueUpload = useCallback(
      async (
        destination: string,
        kind: "files" | "folders",
        strategy: TransferStrategy = "direct",
      ) => {
        try {
          const sources =
            kind === "files"
              ? await pickUploadFiles(t("menu.uploadFiles"))
              : await pickUploadFolders(t("menu.uploadFolder"));
          if (sources.length === 0) return;
          const enqueue =
            strategy === "archive"
              ? transferNative.enqueueArchive
              : transferNative.enqueueDirect;
          await enqueue({
            direction: "upload",
            sources,
            destination,
          });
          toast.success(t("menu.transferQueued"));
        } catch (error) {
          toast.error(
            t("menu.transferFailed", {
              error: formatTransferError(error, t),
            }),
          );
        }
      },
      [t],
    );

    /** 选择宿主机目录并创建后台下载任务。 */
    const enqueueDownload = useCallback(
      async (source: string, strategy: TransferStrategy = "direct") => {
        try {
          const destination = await pickDownloadDirectory(
            t("menu.downloadToLocal"),
          );
          if (!destination) return;
          const enqueue =
            strategy === "archive"
              ? transferNative.enqueueArchive
              : transferNative.enqueueDirect;
          await enqueue({
            direction: "download",
            sources: [source],
            destination,
          });
          toast.success(t("menu.transferQueued"));
        } catch (error) {
          toast.error(
            t("menu.transferFailed", {
              error: formatTransferError(error, t),
            }),
          );
        }
      },
      [t],
    );
    const gitDecorations = usePreferencesStore((s) => s.explorerGitDecorations);
    const { lookup: lookupGitStatus } = useGitStatus(
      rootPath,
      gitDecorations ? gitStatus : null,
      gitDecorations,
    );
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [isSearchActive, setIsSearchActive] = useState(false);
    const searchRef = useRef<ExplorerSearchHandle>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const treeRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    // biome-ignore lint/correctness/useExhaustiveDependencies: buildRows reads selected tree slices to avoid rebuilding on unrelated tree changes.
    const { rows, entryIndexByPath } = useMemo(() => {
      if (!rootPath)
        return {
          rows: [] as Row[],
          entryIndexByPath: new Map<string, number>(),
        };
      return buildRows(rootPath, tree, lookupGitStatus, t("loading"));
    }, [
      rootPath,
      tree.nodes,
      tree.expanded,
      tree.renaming,
      tree.pendingCreate,
      lookupGitStatus,
      t,
    ]);

    const rowActions = useMemo<RowActions>(
      () => ({
        toggle: tree.toggle,
        beginRename: tree.beginRename,
        commitRename: tree.commitRename,
        cancelRename: tree.cancelRename,
      }),
      [tree.toggle, tree.beginRename, tree.commitRename, tree.cancelRename],
    );
    const renameInProgress =
      tree.renaming !== null || tree.pendingCreate !== null;

    const [menuTarget, setMenuTarget] = useState<EntryTarget | null>(null);
    const [contextMenuPath, setContextMenuPath] = useState<string | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    const [permanentDeleteTarget, setPermanentDeleteTarget] =
      useState<EntryTarget | null>(null);
    // Bumped on every right-click so the menu content remounts and the popper
    // re-anchors to the new cursor (floating-ui won't reposition on an anchor
    // change alone, only on scroll/resize).
    const [menuNonce, setMenuNonce] = useState(0);

    const entryPaths = useMemo<string[]>(() => {
      const out: string[] = [];
      for (const row of rows) if (row.kind === "entry") out.push(row.path);
      return out;
    }, [rows]);

    const isDirAt = useCallback(
      (path: string): boolean | undefined => {
        const idx = entryIndexByPath.get(path);
        const row = idx !== undefined ? rows[idx] : undefined;
        return row?.kind === "entry" ? row.isDir : undefined;
      },
      [entryIndexByPath, rows],
    );
    const dnd = useExplorerDnd({
      rootPath: rootPath ?? "",
      isDir: isDirAt,
      onMove: tree.movePath,
      onDropToWorkbench,
    });

    const fileDrop = useExplorerFileDrop({
      rootPath,
      isDir: isDirAt,
      onCopied: tree.refresh,
    });

    const dropTargetDir = dnd.dropTargetDir ?? fileDrop.externalTargetDir;
    const rootIsDropTarget =
      dropTargetDir != null && dropTargetDir === rootPath;
    useEffect(() => {
      if (!dropTargetDir || dropTargetDir === rootPath) return;
      if (tree.expanded.has(dropTargetDir)) return;
      const id = window.setTimeout(() => tree.expand(dropTargetDir), 700);
      return () => window.clearTimeout(id);
    }, [dropTargetDir, rootPath, tree.expanded, tree.expand]);

    useEffect(() => {
      if (selectedPath && !entryIndexByPath.has(selectedPath)) {
        setSelectedPath(null);
      }
    }, [entryIndexByPath, selectedPath]);

    const virtualizer = useVirtualizer({
      count: rows.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => ROW_HEIGHT,
      overscan: OVERSCAN,
      getItemKey: (index) => rows[index]?.key ?? index,
    });

    const scrollEntryIntoView = useCallback(
      (path: string) => {
        const index = entryIndexByPath.get(path);
        if (index === undefined) return;
        virtualizer.scrollToIndex(index, { align: "auto" });
      },
      [entryIndexByPath, virtualizer],
    );

    const lastSyncedActivePathRef = useRef<string | null>(null);
    useEffect(() => {
      lastSyncedActivePathRef.current = null;
    }, [rootPath]);

    useEffect(() => {
      if (
        !activeFilePath ||
        activeFilePath === lastSyncedActivePathRef.current
      ) {
        return;
      }
      if (rootPath) {
        for (const dir of ancestorDirs(rootPath, activeFilePath)) {
          tree.expand(dir);
        }
      }
      if (!entryIndexByPath.has(activeFilePath)) return;
      lastSyncedActivePathRef.current = activeFilePath;
      setSelectedPath(activeFilePath);
      requestAnimationFrame(() => scrollEntryIntoView(activeFilePath));
    }, [
      activeFilePath,
      rootPath,
      entryIndexByPath,
      scrollEntryIntoView,
      tree.expand,
    ]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          if (treeRef.current) treeRef.current.focus();
          else searchRef.current?.focus();
          if (!selectedPath && entryPaths.length > 0) {
            const first = entryPaths[0];
            setSelectedPath(first);
            requestAnimationFrame(() => scrollEntryIntoView(first));
          }
        },
        isFocused: () => {
          const c = containerRef.current;
          if (!c) return false;
          const active = document.activeElement;
          return active instanceof Node && c.contains(active);
        },
        focusSearch: () => {
          setIsSearchOpen(true);
          searchRef.current?.focus();
        },
        collapseAll: tree.collapseAll,
      }),
      [entryPaths, scrollEntryIntoView, selectedPath, tree.collapseAll],
    );

    const requestTrashDelete = useCallback(
      (target: EntryTarget) => {
        void tree.trashPath(target.path).then((result) => {
          if (result.kind === "unavailable") {
            setPermanentDeleteTarget(target);
          } else if (result.kind === "error") {
            toast.error(result.reason);
          }
        });
      },
      [tree.trashPath],
    );

    useGlobalShortcuts({
      "explorer.search": () => {
        if (searchRef.current?.isFocused()) {
          setIsSearchOpen(false);
          return;
        }
        setIsSearchOpen(true);
        searchRef.current?.focus();
      },
    });

    if (!rootPath) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <HugeiconsIcon
            icon={Folder01Icon}
            size={24}
            strokeWidth={1.5}
            className="text-muted-foreground"
          />
          <div className="text-xs text-muted-foreground">
            {t("noCurrentDirectory")}
          </div>
          {onOpenFolder ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-1 h-7 gap-1.5 text-xs"
              onClick={onOpenFolder}
            >
              <HugeiconsIcon icon={FolderOpenIcon} size={13} strokeWidth={2} />
              {t("openFolder")}
            </Button>
          ) : null}
        </div>
      );
    }

    const root = tree.nodes[rootPath];
    const pendingAtRoot =
      tree.pendingCreate?.parentPath === rootPath ? tree.pendingCreate : null;

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (tree.renaming || tree.pendingCreate || isSearchOpen) return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      )
        return;
      if (entryPaths.length === 0) return;

      const currentIdx = selectedPath ? entryPaths.indexOf(selectedPath) : -1;
      const move = (next: number) => {
        const clamped = Math.max(0, Math.min(entryPaths.length - 1, next));
        const path = entryPaths[clamped];
        setSelectedPath(path);
        requestAnimationFrame(() => scrollEntryIntoView(path));
      };

      switch (e.key) {
        case "F2": {
          if (currentIdx < 0) return;
          e.preventDefault();
          tree.beginRename(entryPaths[currentIdx]);
          break;
        }
        case "Delete": {
          if (currentIdx < 0) return;
          e.preventDefault();
          const path = entryPaths[currentIdx];
          const idx = entryIndexByPath.get(path);
          const row = idx === undefined ? undefined : rows[idx];
          if (row?.kind === "entry") {
            requestTrashDelete({
              path: row.path,
              name: row.name,
              isDir: row.isDir,
            });
          }
          break;
        }
        case "ArrowDown":
          e.preventDefault();
          move(currentIdx < 0 ? 0 : currentIdx + 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          move(currentIdx < 0 ? entryPaths.length - 1 : currentIdx - 1);
          break;
        case "ArrowRight": {
          if (currentIdx < 0) return;
          e.preventDefault();
          const path = entryPaths[currentIdx];
          const idx = entryIndexByPath.get(path);
          if (idx === undefined) break;
          const row = rows[idx];
          if (row.kind !== "entry") break;
          if (row.isDir) {
            if (!row.isExpanded) tree.toggle(row.path);
            else move(currentIdx + 1);
          }
          break;
        }
        case "ArrowLeft": {
          if (currentIdx < 0) return;
          e.preventDefault();
          const path = entryPaths[currentIdx];
          const idx = entryIndexByPath.get(path);
          if (idx === undefined) break;
          const row = rows[idx];
          if (row.kind !== "entry") break;
          if (row.isDir && row.isExpanded) {
            tree.toggle(row.path);
          } else {
            const parent = row.path.slice(0, row.path.lastIndexOf("/"));
            if (parent && parent !== rootPath) setSelectedPath(parent);
          }
          break;
        }
        case "Enter": {
          if (currentIdx < 0) return;
          e.preventDefault();
          const path = entryPaths[currentIdx];
          const idx = entryIndexByPath.get(path);
          if (idx === undefined) break;
          const row = rows[idx];
          if (row.kind !== "entry") break;
          if (row.isDir) tree.toggle(row.path);
          else onOpenFile(row.path);
          break;
        }
      }
    };

    const renderRow = (row: Row) => {
      switch (row.kind) {
        case "entry":
        case "rename": {
          return (
            <EntryRow
              domId={`file-tree-item-${encodeURIComponent(row.path)}`}
              path={row.path}
              name={row.name}
              isDir={row.isDir}
              isExpanded={row.kind === "entry" ? row.isExpanded : false}
              depth={row.depth}
              actions={rowActions}
              renameInProgress={renameInProgress}
              isSelected={selectedPath === row.path}
              isContextTarget={contextMenuPath === row.path}
              isRenaming={row.kind === "rename"}
              isDropTarget={dropTargetDir === row.path}
              onOpenFile={onOpenFile}
              onSelectPath={setSelectedPath}
              gitStatusCode={row.gitStatusCode}
              gitignored={gitDecorations && row.gitignored}
            />
          );
        }
        case "pending":
          return (
            <PendingRow
              depth={row.depth}
              kind={row.pendingKind}
              onCommit={tree.commitCreate}
              onCancel={tree.cancelCreate}
            />
          );
        case "status":
          return (
            <StatusRow
              depth={row.depth}
              message={row.message}
              tone={row.tone}
            />
          );
      }
    };

    return (
      <div ref={containerRef} className="flex h-full flex-col outline-none">
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2">
          <span
            className="flex flex-1 items-center truncate text-xs font-medium text-foreground"
            title={rootPath}
          >
            <img
              src={folderIconUrl(basename(rootPath), false)}
              alt=""
              height={15}
              width={15}
              className="mx-1.5"
            />
            {basename(rootPath)}
          </span>

          {onOpenFolder ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={onOpenFolder}
              title={t("openFolder")}
              aria-label={t("openFolder")}
            >
              <HugeiconsIcon icon={FolderOpenIcon} size={13} strokeWidth={2} />
            </Button>
          ) : null}

          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => setIsSearchOpen((v) => !v)}
            title={t("searchFiles")}
            aria-label={t("searchFiles")}
          >
            <HugeiconsIcon icon={Search01Icon} size={13} strokeWidth={2} />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => tree.beginCreate(rootPath, "file")}
            title={t("newFile")}
          >
            <HugeiconsIcon icon={FileAddIcon} size={13} strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => tree.beginCreate(rootPath, "dir")}
            title={t("newFolder")}
          >
            <HugeiconsIcon icon={FolderAddIcon} size={13} strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => tree.refresh(rootPath)}
            title="Refresh"
            aria-label="Refresh"
          >
            <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={tree.collapseAll}
            title="Collapse All"
            aria-label="Collapse All"
          >
            <HugeiconsIcon
              icon={ListChevronsDownUpIcon}
              size={13}
              strokeWidth={2}
            />
          </Button>
        </div>

        <ExplorerSearch
          ref={searchRef}
          rootPath={rootPath}
          onOpenFile={onOpenFile}
          open={isSearchOpen}
          onRequestClose={() => setIsSearchOpen(false)}
          onActiveChange={setIsSearchActive}
          onRevealInTerminal={onRevealInTerminal}
          onAttachToAgent={onAttachToAgent}
        />

        {!isSearchActive ? (
          <ContextMenu
            onOpenChange={(open) => {
              if (!open) {
                setDeleteConfirm(false);
                setContextMenuPath(null);
              }
            }}
          >
            <ContextMenuTrigger asChild>
              <div
                ref={(node) => {
                  scrollRef.current = node;
                  treeRef.current = node;
                }}
                data-explorer-drop=""
                role="tree"
                aria-label={t("files")}
                aria-activedescendant={
                  selectedPath
                    ? `file-tree-item-${encodeURIComponent(selectedPath)}`
                    : undefined
                }
                tabIndex={0}
                className={cn(
                  "app-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]",
                  rootIsDropTarget &&
                    "rounded-sm ring-1 ring-inset ring-primary/50",
                )}
                onPointerDown={dnd.onPointerDown}
                onClickCapture={dnd.onClickCapture}
                onKeyDown={handleKeyDown}
                onContextMenuCapture={(e) => {
                  const el = (e.target as HTMLElement).closest<HTMLElement>(
                    "[data-fs-path]",
                  );
                  const path = el?.getAttribute("data-fs-path") ?? null;
                  const idx =
                    path != null ? entryIndexByPath.get(path) : undefined;
                  const row = idx !== undefined ? rows[idx] : undefined;
                  setContextMenuPath(
                    row && row.kind === "entry" ? row.path : null,
                  );
                  setMenuTarget(
                    row && row.kind === "entry"
                      ? { path: row.path, name: row.name, isDir: row.isDir }
                      : null,
                  );
                  setDeleteConfirm(false);
                  setMenuNonce((n) => n + 1);
                }}
              >
                {pendingAtRoot ? (
                  <div
                    role="treeitem"
                    aria-level={1}
                    tabIndex={-1}
                    className="flex h-6 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
                    style={{ paddingLeft: 6 }}
                  >
                    <span className="size-3.5 shrink-0" />
                    <img
                      src={
                        pendingAtRoot.kind === "dir"
                          ? folderIconUrl("", false)
                          : fileIconUrl("untitled")
                      }
                      alt=""
                      className="size-4 shrink-0 opacity-70"
                    />
                    <InlineInput
                      initial=""
                      placeholder={
                        pendingAtRoot.kind === "dir"
                          ? t("newFolder")
                          : t("newFile")
                      }
                      onCommit={tree.commitCreate}
                      onCancel={tree.cancelCreate}
                    />
                  </div>
                ) : null}
                {root?.status === "loading" && (
                  <div
                    role="treeitem"
                    aria-level={1}
                    aria-disabled
                    tabIndex={-1}
                    className="px-3 py-2 text-[11px] text-muted-foreground"
                  >
                    {t("loading")}
                  </div>
                )}
                {root?.status === "error" && (
                  <div
                    role="treeitem"
                    aria-level={1}
                    aria-disabled
                    tabIndex={-1}
                    className="px-3 py-2 text-[11px] text-destructive"
                  >
                    {root.message}
                  </div>
                )}
                {root?.status === "loaded" ? (
                  <div
                    style={{
                      height: virtualizer.getTotalSize(),
                      position: "relative",
                      width: "100%",
                    }}
                  >
                    {virtualizer.getVirtualItems().map((virtualRow) => {
                      const row = rows[virtualRow.index];
                      if (!row) return null;
                      return (
                        <div
                          key={virtualRow.key}
                          data-virtual-row-index={virtualRow.index}
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            height: virtualRow.size,
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                        >
                          {renderRow(row)}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent
              key={menuNonce}
              className={COMPACT_CONTENT}
              onCloseAutoFocus={(e) => {
                if (tree.renaming || tree.pendingCreate) e.preventDefault();
              }}
            >
              {menuTarget ? (
                <>
                  {!menuTarget.isDir && (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => onOpenFile(menuTarget.path, true)}
                    >
                      {t("menu.open")}
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => tree.beginRename(menuTarget.path)}
                  >
                    {t("common:rename")}
                  </ContextMenuItem>
                  {menuTarget.isDir && onRevealInTerminal && (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => onRevealInTerminal(menuTarget.path)}
                    >
                      {t("menu.openInTerminal")}
                    </ContextMenuItem>
                  )}
                  {workspaceEnv.kind !== "local" ? (
                    <>
                      <TransferStrategyMenu
                        label={t("menu.downloadToLocal")}
                        onSelect={(strategy) =>
                          void enqueueDownload(menuTarget.path, strategy)
                        }
                      />
                      {(["files", "folders"] as const).map((kind) => (
                        <TransferStrategyMenu
                          key={kind}
                          label={t(
                            kind === "files"
                              ? "menu.uploadFiles"
                              : "menu.uploadFolder",
                          )}
                          onSelect={(strategy) => {
                            const remoteDir = menuTarget.isDir
                              ? menuTarget.path
                              : parentOf(menuTarget.path, rootPath);
                            void enqueueUpload(remoteDir, kind, strategy);
                          }}
                        />
                      ))}
                    </>
                  ) : (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => void revealInFinder(menuTarget.path)}
                    >
                      {t("menu.revealInFinder")}
                    </ContextMenuItem>
                  )}
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() =>
                      tree.beginCreate(
                        menuTarget.isDir
                          ? menuTarget.path
                          : parentOf(menuTarget.path, rootPath),
                        "file",
                      )
                    }
                  >
                    {t("menu.newFile")}
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() =>
                      tree.beginCreate(
                        menuTarget.isDir
                          ? menuTarget.path
                          : parentOf(menuTarget.path, rootPath),
                        "dir",
                      )
                    }
                  >
                    {t("menu.newFolder")}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => void copyToClipboard(menuTarget.path)}
                  >
                    {t("menu.copyPath")}
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() =>
                      void copyToClipboard(
                        relativePath(rootPath, menuTarget.path),
                      )
                    }
                  >
                    {t("menu.copyRelativePath")}
                  </ContextMenuItem>
                  {!menuTarget.isDir && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        className={COMPACT_ITEM}
                        onSelect={() => onAttachToAgent?.(menuTarget.path)}
                      >
                        {t("menu.attachToAgent")}
                      </ContextMenuItem>
                    </>
                  )}
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    variant="destructive"
                    onSelect={(e) => {
                      if (deleteConfirm) {
                        void tree.deletePath(menuTarget.path);
                      } else {
                        // Keep the menu open on the first click so the user
                        // can confirm; let it close normally on the second.
                        e.preventDefault();
                        setDeleteConfirm(true);
                      }
                    }}
                  >
                    {deleteConfirm
                      ? t("menu.confirmDelete")
                      : t("common:delete")}
                  </ContextMenuItem>
                </>
              ) : (
                <>
                  {onRevealInTerminal && (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => onRevealInTerminal(rootPath)}
                    >
                      {t("menu.openInTerminal")}
                    </ContextMenuItem>
                  )}
                  {workspaceEnv.kind !== "local" ? (
                    <>
                      {(["files", "folders"] as const).map((kind) => (
                        <TransferStrategyMenu
                          key={kind}
                          label={t(
                            kind === "files"
                              ? "menu.uploadFiles"
                              : "menu.uploadFolder",
                          )}
                          onSelect={(strategy) =>
                            void enqueueUpload(rootPath, kind, strategy)
                          }
                        />
                      ))}
                    </>
                  ) : (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => void revealInFinder(rootPath)}
                    >
                      {t("menu.revealInFinder")}
                    </ContextMenuItem>
                  )}
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => tree.beginCreate(rootPath, "file")}
                  >
                    {t("menu.newFile")}
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => tree.beginCreate(rootPath, "dir")}
                  >
                    {t("menu.newFolder")}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => void copyToClipboard(rootPath)}
                  >
                    {t("menu.copyPath")}
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => tree.refresh(rootPath)}
                  >
                    {t("menu.refresh")}
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
        ) : null}

        <AlertDialog
          open={permanentDeleteTarget !== null}
          onOpenChange={(open) => {
            if (!open) setPermanentDeleteTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("menu.deletePermanentlyTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {permanentDeleteTarget
                  ? t("menu.deletePermanentlyDescription", {
                      name: permanentDeleteTarget.name,
                    })
                  : ""}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  if (!permanentDeleteTarget) return;
                  void tree.deletePath(permanentDeleteTarget.path);
                  setPermanentDeleteTarget(null);
                }}
              >
                {t("menu.deletePermanently")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {dnd.dragLabel ? (
          <div
            ref={dnd.ghostRef}
            className="pointer-events-none fixed left-0 top-0 z-50 flex items-center gap-1.5 rounded-sm border border-border/70 bg-card/95 px-2 py-1 text-[12px] text-foreground shadow-md"
          >
            {dnd.dragLabel}
          </div>
        ) : null}
      </div>
    );
  }),
);

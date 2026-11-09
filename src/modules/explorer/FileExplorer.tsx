/**
 * 本文件实现工作区文件资源管理器。
 * 负责文件树、搜索、常规文件操作和非本地 Workspace 的后台传输入口。
 * 文件树按普通文档流保留全部展示行，避免侧栏恢复依赖虚拟滚动范围。
 * 空态目录动作由上层按 Local、WSL 或 SSH 环境提供。
 */

import {
  useViewActive,
  useViewState,
  useViewScroll,
} from "@/modules/view-state";
import { FolderSyncDialog } from "@/modules/transfers/FolderSyncDialog";
import { DirectoryPathInput } from "@/modules/workspace/DirectoryPathInput";
import { FILE_DROP_TARGET_CLASS } from "@/components/controls/file-drop-outline";
import { Hint } from "@/components/controls/tooltip";
import { FileActionItems } from "@/modules/file-actions/FileActionItems";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/menu/context-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/controls/alert-dialog";
import { Button } from "@/components/controls/button";
import { Spinner } from "@/components/ui/spinner";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { scrollListRowIntoView } from "@/lib/scrollIntoView";
import { cn } from "@/lib/utils";
import { FileTimeline } from "@/modules/git-history/FileTimeline";
import { SidebarSectionAction, SidebarSectionGroup } from "@/modules/sidebar";
import { useRepositorySnapshot } from "@/modules/source-control/RepositoryContext";
import type {
  CommitFileDiffOpenInput,
  GitStatusSnapshot,
} from "@/modules/ai/lib/native";
import { openFileProperties } from "@/modules/file-properties/openFileProperties";
import { isPythonFile } from "@/modules/python/path";
import {
  type RemoteRuntimeSnapshot,
  useRemoteRuntimeStore,
} from "@/modules/remote";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useGlobalShortcuts } from "@/modules/shortcuts";
import {
  pickDownloadDirectory,
  pickUploadFiles,
  pickUploadFolders,
} from "@/modules/transfers/dialogs";
import { formatTransferError } from "@/modules/transfers/errors";
import { transferNative } from "@/modules/transfers/native";
import { requestTransferPanel } from "@/modules/transfers/store";
import type { TransferStrategy } from "@/modules/transfers/types";
import type { WorkbenchDropTarget } from "@/modules/workbench/dragSession";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import FileAddIcon from "@hugeicons/core-free-icons/FileAddIcon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";
import FolderAddIcon from "@hugeicons/core-free-icons/FolderAddIcon";
import FolderOpenIcon from "@hugeicons/core-free-icons/FolderOpenIcon";
import ListChevronsDownUpIcon from "@hugeicons/core-free-icons/ListChevronsDownUpIcon";
import Refresh01Icon from "@hugeicons/core-free-icons/Refresh01Icon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
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
import { reportError } from "@/lib/errors";
import {
  ExplorerSearch,
  type ExplorerSearchHandle,
} from "@/modules/explorer/ExplorerSearch";
import {
  copyToClipboard,
  relativePath,
} from "@/modules/explorer/lib/contextActions";
import type { GitStatusCode } from "@/modules/explorer/lib/gitStatusUtils";
import { folderIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  explorerClipboardCommand,
  explorerPasteError,
  useExplorerClipboard,
} from "@/modules/explorer/lib/useExplorerClipboard";
import { useExplorerDnd } from "@/modules/explorer/lib/useExplorerDnd";
import { useExplorerFileDrop } from "@/modules/explorer/lib/useExplorerFileDrop";
import {
  ancestorDirs,
  dirname,
  useFileTree,
} from "@/modules/explorer/lib/useFileTree";
import { useGitStatus } from "@/modules/explorer/lib/useGitStatus";
import {
  EntryRow,
  PendingRow,
  type RowActions,
  StatusRow,
} from "@/modules/explorer/TreeRow";

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
      <ContextMenuSubTrigger>{label}</ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {(["direct", "archive"] as const).map((strategy) => (
          <ContextMenuItem key={strategy} onSelect={() => onSelect(strategy)}>
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
  rootPending?: "connection" | "loading";
  active?: boolean;
  onOpenFolder?: () => void;
  openFolderLabel?: string;
  onOpenInNewSpace?: (path: string) => void;
  onOpenHome?: () => void;
  onOpenPath?: (path: string) => void;
  onReconnect?: () => void;
  activeFilePath?: string | null;
  onOpenFile: (path: string, pin?: boolean) => void;
  onOpenCommitFile?: (input: CommitFileDiffOpenInput) => void;
  onPathRenamed?: (from: string, to: string) => void;
  onPathDeleted?: (path: string) => void;
  onRevealInTerminal?: (path: string) => void;
  onRunPythonFile?: (path: string, root: string) => void;
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
      isDeleting: boolean;
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
      isDeleting: boolean;
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

type RemoteNoticePhase = Extract<
  RemoteRuntimeSnapshot["phase"],
  "connecting" | "reconnecting" | "disconnected"
>;

/** 展示 SSH 连接过程和断开状态，并保留手动重连入口。 */
function RemoteConnectionNotice({
  phase,
  onReconnect,
}: {
  phase: RemoteNoticePhase;
  onReconnect?: () => void;
}) {
  const { t } = useTranslation("common");
  const pending = phase !== "disconnected";
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
      {pending ? (
        <Spinner
          className="size-4 motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <span
          className="size-2 rounded-full bg-destructive"
          aria-hidden="true"
        />
      )}
      {phase === "connecting" ? (
        <span>{t("remoteWorkspace.connecting")}</span>
      ) : (
        <>
          <span className="text-foreground">
            {t("remoteWorkspace.connectionClosed")}
          </span>
          <span>
            {t(
              phase === "reconnecting"
                ? "remoteWorkspace.reconnecting"
                : "remoteWorkspace.manualReconnect",
            )}
          </span>
        </>
      )}
      {!pending && onReconnect ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-1"
          onClick={onReconnect}
        >
          {t("remoteWorkspace.reconnectAction")}
        </Button>
      ) : null}
    </div>
  );
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/**
 * 返回路径的直接父目录，同时兼容前端规范路径和系统反斜杠路径。
 */
function parentOf(path: string, fallback: string): string {
  const separatorIndex = Math.max(
    path.lastIndexOf("/"),
    path.lastIndexOf("\\"),
  );
  if (separatorIndex < 0) return fallback;
  if (separatorIndex === 0) return path.slice(0, 1);

  const parent = path.slice(0, separatorIndex);
  return /^[A-Za-z]:$/.test(parent)
    ? `${parent}${path[separatorIndex]}`
    : parent;
}

/**
 * 解析资源管理器顶部创建按钮的目标目录。
 *
 * 选中文件夹时使用文件夹自身，选中文件时使用其直接父目录；
 * 没有有效选择时回退到工作区根目录。
 */
export function resolveToolbarCreateParent(
  rootPath: string,
  selectedPath: string | null,
  selectedIsDir: boolean | undefined,
): string {
  if (!selectedPath || selectedIsDir === undefined) return rootPath;
  return selectedIsDir ? selectedPath : parentOf(selectedPath, rootPath);
}

/**
 * 计算创建草稿在已排序目录条目中的插入位置。
 *
 * 文件夹草稿保持在最前；文件草稿放在所有文件夹之后、第一个文件或符号链接之前。
 */
export function resolvePendingCreateIndex(
  entries: readonly { kind: "file" | "dir" | "symlink" }[],
  kind: "file" | "dir",
): number {
  if (kind === "dir") return 0;
  const firstFileIndex = entries.findIndex((entry) => entry.kind !== "dir");
  return firstFileIndex < 0 ? entries.length : firstFileIndex;
}

function buildRows(
  rootPath: string,
  tree: ReturnType<typeof useFileTree>,
  lookup: (path: string) => GitStatusCode | null,
  loadingLabel: string,
): { rows: Row[]; entryIndexByPath: Map<string, number> } {
  const rows: Row[] = [];
  const entryIndexByPath = new Map<string, number>();

  const appendPending = (parentPath: string, depth: number) => {
    const pending = tree.pendingCreate;
    if (!pending || pending.parentPath !== parentPath) return;
    rows.push({
      kind: "pending",
      key: `pending:${parentPath}`,
      depth,
      pendingKind: pending.kind,
    });
  };

  const walk = (parent: string, depth: number, parentIgnored: boolean) => {
    const node = tree.nodes[parent];
    if (node?.status !== "loaded") return;
    const pending = tree.pendingCreate;
    const pendingIndex =
      pending?.parentPath === parent
        ? resolvePendingCreateIndex(node.entries, pending.kind)
        : -1;

    for (const [entryIndex, entry] of node.entries.entries()) {
      if (entryIndex === pendingIndex) appendPending(parent, depth);
      const path = tree.joinPath(parent, entry.name);
      const isDir = entry.kind === "dir";
      const isDeleting = tree.deletingPaths.has(path);
      const expanded = isDir && !isDeleting && tree.expanded.has(path);
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
          isDeleting,
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
          isDeleting,
          depth,
          gitignored,
          gitStatusCode,
        });
      }
      if (isDir && expanded) {
        const child = tree.nodes[path];
        if (child?.status !== "loaded") appendPending(path, depth + 1);
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
    if (pendingIndex === node.entries.length) appendPending(parent, depth);
  };

  walk(rootPath, 0, false);
  return { rows, entryIndexByPath };
}

/**
 * 文件资源管理器组件。
 *
 * 展示当前终端驱动的目录树，并呈现 SSH 恢复进度和统一的手动重连入口。
 * 按运行环境提供本地根目录选择或后台传输操作，隐藏时暂停远端目录轮询。
 * 根目录标题可快速返回文件树顶部，并与树空白区域共享根目录右键菜单。
 */
export const FileExplorer = memo(
  forwardRef<FileExplorerHandle, Props>(function FileExplorer(
    {
      rootPath,
      rootPending,
      active: requestedActive,
      onOpenFolder,
      openFolderLabel,
      onOpenInNewSpace,
      onOpenHome,
      onOpenPath,
      onReconnect,
      activeFilePath,
      onOpenFile,
      onOpenCommitFile,
      onPathRenamed,
      onPathDeleted,
      onRevealInTerminal,
      onRunPythonFile,
      onAttachToAgent,
      onDropToWorkbench,
      gitStatus,
    },
    ref,
  ) {
    const { t } = useTranslation(["explorer", "statusbar"]);
    const active = useViewActive(requestedActive);
    const repository = useRepositorySnapshot();
    const [timelineRefreshToken, setTimelineRefreshToken] = useViewState(
      "timelineRefreshToken",
      0,
    );
    const tree = useFileTree(rootPath, {
      onPathRenamed,
      onPathDeleted,
      active,
    });
    const workspaceEnv = useWorkspaceEnvStore((state) => state.env);
    const runtime = useRemoteRuntimeStore((state) => state.snapshot);
    const remotePhase =
      workspaceEnv.kind === "ssh" &&
      (runtime.phase === "connecting" ||
        runtime.phase === "reconnecting" ||
        runtime.phase === "disconnected") &&
      runtime.profileId === workspaceEnv.profileId
        ? runtime.phase
        : null;
    const [emptyPath, setEmptyPath] = useState("");
    const [syncPath, setSyncPath] = useState<string | null>(null);

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
          const task = await transferNative.enqueue({
            direction: "upload",
            strategy,
            sources,
            destination,
          });
          requestTransferPanel(task.id);
        } catch (error) {
          reportError(
            t("menu.transferFailed", {
              error: formatTransferError(error, t),
            }),
            { error },
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
          const task = await transferNative.enqueue({
            direction: "download",
            strategy,
            sources: [source],
            destination,
          });
          requestTransferPanel(task.id);
        } catch (error) {
          reportError(
            t("menu.transferFailed", {
              error: formatTransferError(error, t),
            }),
            { error },
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
    const [selectedPath, setSelectedPath] = useViewState<string | null>(
      "selectedPath",
      null,
    );
    const [isSearchOpen, setIsSearchOpen] = useViewState("searchOpen", false);
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

    const rowKeys = useMemo(() => rows.map((row) => row.key), [rows]);
    const attachScroll = useViewScroll(
      "tree",
      scrollRef,
      rowKeys,
      active && !isSearchActive,
      24,
    );
    const attachTree = useCallback(
      (node: HTMLDivElement | null) => {
        attachScroll(node);
        treeRef.current = node;
      },
      [attachScroll],
    );

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
    const menuSourcePointRef = useRef<{
      x: number;
      y: number;
    } | null>(null);
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
        return row?.kind === "entry" && !row.isDeleting ? row.isDir : undefined;
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
    const clipboard = useExplorerClipboard(workspaceEnv, fileDrop.pasteFiles);
    const pasteView = useRef({ rootPath, expanded: tree.expanded });
    pasteView.current = { rootPath, expanded: tree.expanded };
    const [pasteSelection, setPasteSelection] = useState<{
      root: string;
      path: string;
    } | null>(null);

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
      if (
        selectedPath &&
        tree.nodes[dirname(selectedPath)]?.status === "loaded" &&
        !entryIndexByPath.has(selectedPath)
      ) {
        setSelectedPath(null);
      }
    }, [entryIndexByPath, selectedPath, tree.nodes]);

    const scrollEntryIntoView = useCallback((path: string) => {
      scrollListRowIntoView(
        scrollRef.current,
        `file-tree-item-${encodeURIComponent(path)}`,
      );
    }, []);

    useEffect(() => {
      if (!pasteSelection) return;
      if (pasteSelection.root !== rootPath) {
        setPasteSelection(null);
      } else if (entryIndexByPath.has(pasteSelection.path)) {
        setPasteSelection(null);
        setSelectedPath(pasteSelection.path);
        requestAnimationFrame(() => scrollEntryIntoView(pasteSelection.path));
      }
    }, [entryIndexByPath, pasteSelection, rootPath, scrollEntryIntoView]);

    const [lastSyncedActivePath, setLastSyncedActivePath] = useViewState<
      string | null
    >(`activePath:${rootPath}`, null);

    useEffect(() => {
      if (
        !active ||
        !activeFilePath ||
        activeFilePath === lastSyncedActivePath
      ) {
        return;
      }
      if (rootPath) {
        for (const dir of ancestorDirs(rootPath, activeFilePath)) {
          tree.expand(dir);
        }
      }
      if (!entryIndexByPath.has(activeFilePath)) return;
      setLastSyncedActivePath(activeFilePath);
      setSelectedPath(activeFilePath);
      requestAnimationFrame(() => scrollEntryIntoView(activeFilePath));
    }, [
      active,
      lastSyncedActivePath,
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
            reportError(result.reason);
          }
        });
      },
      [tree.trashPath],
    );

    const requestPermanentDelete = useCallback(
      (path: string) => {
        void tree.deletePath(path).then((result) => {
          if (result.kind === "error") {
            reportError(t("menu.deleteFailed", { error: result.reason }));
          }
        });
      },
      [t, tree.deletePath],
    );

    const requestProperties = useCallback(
      (path: string) => {
        void openFileProperties(
          path,
          menuSourcePointRef.current ?? undefined,
        ).catch((error) =>
          reportError(
            t("menu.propertiesOpenFailed", { error: String(error) }),
            { error },
          ),
        );
      },
      [t],
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
      const connectionPhase =
        remotePhase ?? (rootPending === "connection" ? "connecting" : null);
      if (connectionPhase) {
        return (
          <RemoteConnectionNotice
            phase={connectionPhase}
            onReconnect={onReconnect}
          />
        );
      }
      if (rootPending === "loading") {
        return (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
            <Spinner
              className="size-4 motion-reduce:animate-none"
              aria-hidden="true"
            />
            <span>{t("loading")}</span>
          </div>
        );
      }
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
          {onOpenFolder && !onOpenPath ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-1"
              onClick={onOpenFolder}
            >
              <HugeiconsIcon icon={FolderOpenIcon} size={13} strokeWidth={2} />
              {openFolderLabel ?? t("openFolder")}
            </Button>
          ) : null}
          {onOpenHome ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-1 w-full max-w-64"
              onClick={onOpenHome}
            >
              <HugeiconsIcon icon={FolderOpenIcon} size={13} strokeWidth={2} />
              {t("openHome")}
            </Button>
          ) : null}
          {onOpenPath ? (
            <form
              className="mt-1 flex w-full max-w-64 flex-col gap-1.5 text-left"
              onSubmit={(event) => {
                event.preventDefault();
                const path = emptyPath.trim();
                if (path) onOpenPath(path);
              }}
            >
              <h3 className="text-xs text-muted-foreground">
                {openFolderLabel ?? t("openPath")}
              </h3>
              <div className="flex gap-1.5">
                <DirectoryPathInput
                  value={emptyPath}
                  onValueChange={setEmptyPath}
                  placeholder={t("pathPlaceholder")}
                  aria-label={t("pathPlaceholder")}
                  className="h-7 min-w-0 flex-1"
                />
                <Hint content={openFolderLabel ?? t("openPath")}>
                  <Button
                    type="submit"
                    variant="outline"
                    size="icon-sm"
                    aria-label={openFolderLabel ?? t("openPath")}
                  >
                    <HugeiconsIcon
                      icon={FolderAddIcon}
                      size={13}
                      strokeWidth={2}
                    />
                  </Button>
                </Hint>
              </div>
            </form>
          ) : null}
        </div>
      );
    }

    if (!tree.remoteReady) {
      return (
        <RemoteConnectionNotice
          phase={
            remotePhase === "connecting" || remotePhase === "reconnecting"
              ? remotePhase
              : "disconnected"
          }
          onReconnect={onReconnect}
        />
      );
    }

    const root = tree.nodes[rootPath];
    const toolbarCreateParent = resolveToolbarCreateParent(
      rootPath,
      selectedPath,
      selectedPath ? isDirAt(selectedPath) : undefined,
    );

    /** 右键以菜单落点为准，键盘以文件树当前选中项为准。 */
    const pasteInto = async (destination: string, system = false) => {
      let result: Awaited<ReturnType<typeof clipboard.paste>>;
      try {
        result = await clipboard.paste(
          destination,
          (path) => (path === rootPath ? path : parentOf(path, rootPath)),
          system,
        );
      } catch (error) {
        reportError(explorerPasteError(t, error), { error });
        return;
      }
      if (!result) return;
      const { source, targetDir, name } = result;
      const path = tree.joinPath(targetDir, name);
      const moved = source.mode === "cut" && path !== source.path;
      if (moved) onPathRenamed?.(source.path, path);
      if (pasteView.current.rootPath !== rootPath) return;
      const sourceParent = parentOf(source.path, rootPath);
      if (
        moved &&
        sourceParent !== targetDir &&
        (sourceParent === rootPath ||
          pasteView.current.expanded.has(sourceParent))
      ) {
        tree.refresh(sourceParent);
      }
      if (targetDir === rootPath || pasteView.current.expanded.has(targetDir)) {
        tree.refresh(targetDir);
      }
      for (const directory of ancestorDirs(rootPath, path))
        tree.expand(directory);
      setPasteSelection({ root: rootPath, path });
    };

    const renderPasteActions = (destination: string) => (
      <>
        <ContextMenuItem
          disabled={clipboard.pasting}
          onSelect={() => void pasteInto(destination)}
        >
          {t("menu.paste")}
          <ContextMenuShortcut>{fmtShortcut(MOD_KEY, "V")}</ContextMenuShortcut>
        </ContextMenuItem>
        {clipboard.entry && (
          <ContextMenuItem
            disabled={clipboard.pasting}
            onSelect={() => void pasteInto(destination, true)}
          >
            {t("menu.pasteSystemFiles")}
          </ContextMenuItem>
        )}
      </>
    );

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (tree.renaming || tree.pendingCreate || isSearchOpen) return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      )
        return;
      const command = explorerClipboardCommand(e);
      if (command) {
        if (command === "cancelCut") {
          if (clipboard.cancelCut()) e.preventDefault();
        } else {
          e.preventDefault();
          if (command === "paste" || command === "pasteSystem") {
            if (!e.repeat)
              void pasteInto(toolbarCreateParent, command === "pasteSystem");
          } else if (selectedPath) {
            const isDir = isDirAt(selectedPath);
            if (isDir !== undefined)
              clipboard.remember(command, selectedPath, isDir);
          }
        }
        return;
      }
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
          const path = entryPaths[currentIdx];
          const idx = entryIndexByPath.get(path);
          const row = idx === undefined ? undefined : rows[idx];
          if (row?.kind !== "entry" || row.isDeleting) return;
          e.preventDefault();
          tree.beginRename(row.path);
          break;
        }
        case "Delete": {
          if (currentIdx < 0) return;
          e.preventDefault();
          const path = entryPaths[currentIdx];
          const idx = entryIndexByPath.get(path);
          const row = idx === undefined ? undefined : rows[idx];
          if (row?.kind === "entry" && !row.isDeleting) {
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
          if (row.kind !== "entry" || row.isDeleting) break;
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
          if (row.kind !== "entry" || row.isDeleting) break;
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
          if (row.kind !== "entry" || row.isDeleting) break;
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
              key={row.key}
              domId={`file-tree-item-${encodeURIComponent(row.path)}`}
              path={row.path}
              name={row.name}
              isDir={row.isDir}
              isExpanded={row.kind === "entry" ? row.isExpanded : false}
              isDeleting={row.isDeleting}
              depth={row.depth}
              actions={rowActions}
              renameInProgress={renameInProgress}
              isSelected={selectedPath === row.path}
              isContextTarget={contextMenuPath === row.path}
              isCut={
                clipboard.entry?.mode === "cut" &&
                clipboard.entry.path === row.path
              }
              isRenaming={row.kind === "rename"}
              isDropTarget={dropTargetDir === row.path}
              onOpenFile={onOpenFile}
              onSelectPath={setSelectedPath}
              gitStatusCode={row.gitStatusCode}
              gitignored={gitDecorations && row.gitignored}
              deletingLabel={t("deleting")}
            />
          );
        }
        case "pending":
          return (
            <PendingRow
              key={row.key}
              depth={row.depth}
              kind={row.pendingKind}
              onCommit={tree.commitCreate}
              onCancel={tree.cancelCreate}
            />
          );
        case "status":
          return (
            <StatusRow
              key={row.key}
              depth={row.depth}
              message={row.message}
              tone={row.tone}
            />
          );
      }
    };

    /** 使用 AI 会话消息跳转相同的原生平滑滚动，并尊重系统的减弱动态效果设置。 */
    const scrollTreeToTop = () => {
      const scrollElement = scrollRef.current;
      if (!scrollElement || scrollElement.scrollTop <= 0) return;
      scrollElement.scrollTo({
        top: 0,
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")
          .matches
          ? "auto"
          : "smooth",
      });
    };

    /** 为文件行、文件树空白处和根目录标题准备同一个右键菜单上下文。 */
    const prepareContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
      const contextSurface = (e.target as HTMLElement).closest<HTMLElement>(
        "[data-explorer-context]",
      );
      if (!contextSurface) {
        e.stopPropagation();
        return;
      }

      const el = (e.target as HTMLElement).closest<HTMLElement>(
        "[data-fs-path]",
      );
      const path = el?.getAttribute("data-fs-path") ?? null;
      const idx = path != null ? entryIndexByPath.get(path) : undefined;
      const row = idx !== undefined ? rows[idx] : undefined;
      const target =
        row && row.kind === "entry" && !row.isDeleting
          ? { path: row.path, name: row.name, isDir: row.isDir }
          : null;
      setContextMenuPath(target?.path ?? null);
      setMenuTarget(target);
      setSelectedPath(target?.path ?? null);
      setDeleteConfirm(false);
      menuSourcePointRef.current =
        e.clientX === 0 && e.clientY === 0
          ? null
          : { x: e.clientX, y: e.clientY };
      setMenuNonce((n) => n + 1);
    };

    return (
      <div ref={containerRef} className="flex h-full flex-col outline-none">
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
              className="flex min-h-0 flex-1 flex-col"
              onContextMenuCapture={prepareContextMenu}
            >
              <SidebarSectionGroup
                id="explorer"
                sections={[
                  {
                    id: "files",
                    title: t("files"),
                    defaultSize: 430,
                    minSize: 120,
                    fixedHeader: (
                      <div className="flex h-full shrink-0 items-center border-b border-border/60 px-2">
                        <Hint content={rootPath}>
                          <button
                            aria-label={rootPath}
                            type="button"
                            data-explorer-context="root"
                            className="flex h-6 min-w-0 flex-1 cursor-pointer items-center truncate rounded-sm text-left text-xs font-medium text-foreground transition-colors duration-control hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            onClick={scrollTreeToTop}
                            onKeyDown={(event) => {
                              if (event.key === "Home") {
                                event.preventDefault();
                                scrollTreeToTop();
                              }
                            }}
                          >
                            <img
                              src={folderIconUrl(basename(rootPath), false)}
                              alt=""
                              height={15}
                              width={15}
                              className="file-type-icon mx-1.5"
                            />
                            <span className="truncate">
                              {basename(rootPath)}
                            </span>
                          </button>
                        </Hint>

                        <div className="ml-0.5 flex shrink-0 items-center gap-0 [&>button]:w-5">
                          {onOpenFolder ? (
                            <Hint content={openFolderLabel ?? t("openFolder")}>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                onClick={onOpenFolder}
                                aria-label={openFolderLabel ?? t("openFolder")}
                              >
                                <HugeiconsIcon
                                  icon={FolderOpenIcon}
                                  className="size-3.75"
                                  strokeWidth={2}
                                />
                              </Button>
                            </Hint>
                          ) : null}

                          <Hint content={t("searchFiles")}>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => setIsSearchOpen((v) => !v)}
                              aria-label={t("searchFiles")}
                            >
                              <HugeiconsIcon
                                icon={Search01Icon}
                                className="size-3.75"
                                strokeWidth={2}
                              />
                            </Button>
                          </Hint>

                          <Hint content={t("newFile")}>
                            <Button
                              aria-label={t("newFile")}
                              variant="ghost"
                              size="icon-xs"
                              onClick={() =>
                                tree.beginCreate(toolbarCreateParent, "file")
                              }
                            >
                              <HugeiconsIcon
                                icon={FileAddIcon}
                                className="size-3.75"
                                strokeWidth={2}
                              />
                            </Button>
                          </Hint>
                          <Hint content={t("newFolder")}>
                            <Button
                              aria-label={t("newFolder")}
                              variant="ghost"
                              size="icon-xs"
                              onClick={() =>
                                tree.beginCreate(toolbarCreateParent, "dir")
                              }
                            >
                              <HugeiconsIcon
                                icon={FolderAddIcon}
                                className="size-3.75"
                                strokeWidth={2}
                              />
                            </Button>
                          </Hint>
                          <Hint content={t("menu.refresh")}>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => tree.refresh(rootPath)}
                              aria-label={t("menu.refresh")}
                            >
                              <HugeiconsIcon
                                icon={Refresh01Icon}
                                className="size-3.75"
                                strokeWidth={2}
                              />
                            </Button>
                          </Hint>
                          <Hint content={t("workspaceSearch:collapseAll")}>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={tree.collapseAll}
                              aria-label={t("workspaceSearch:collapseAll")}
                            >
                              <HugeiconsIcon
                                icon={ListChevronsDownUpIcon}
                                className="size-3.75"
                                strokeWidth={2}
                              />
                            </Button>
                          </Hint>
                        </div>
                      </div>
                    ),
                    render: () => (
                      <div className="flex h-full min-h-0 flex-col">
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
                          <div
                            ref={attachTree}
                            data-explorer-drop=""
                            data-explorer-context="tree"
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
                              rootIsDropTarget && FILE_DROP_TARGET_CLASS,
                            )}
                            onPointerDown={dnd.onPointerDown}
                            onClickCapture={dnd.onClickCapture}
                            onKeyDown={handleKeyDown}
                          >
                            {root?.status === "loading" && (
                              <div
                                role="treeitem"
                                aria-level={1}
                                aria-disabled
                                tabIndex={-1}
                                className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground"
                              >
                                <Spinner
                                  className="size-3 motion-reduce:animate-none"
                                  aria-hidden="true"
                                />
                                <span>{t("loading")}</span>
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
                            {root?.status === "loaded"
                              ? rows.map(renderRow)
                              : null}
                          </div>
                        ) : null}
                      </div>
                    ),
                  },
                  {
                    id: "timeline",
                    title: t("gitHistory:timeline.title"),
                    defaultCollapsed: true,
                    defaultSize: 220,
                    minSize: 100,
                    preservePixelSize: true,
                    description:
                      selectedPath && isDirAt(selectedPath) === false ? (
                        <Hint content={selectedPath}>
                          <span>{basename(selectedPath)}</span>
                        </Hint>
                      ) : undefined,
                    actions: (
                      <SidebarSectionAction
                        label={t("gitHistory:timeline.refresh")}
                        disabled={
                          !repository.repo ||
                          !selectedPath ||
                          isDirAt(selectedPath) !== false
                        }
                        onClick={() =>
                          setTimelineRefreshToken((value) => value + 1)
                        }
                      >
                        <HugeiconsIcon
                          icon={Refresh01Icon}
                          size={13}
                          strokeWidth={1.9}
                        />
                      </SidebarSectionAction>
                    ),
                    render: ({ expanded, present }) => (
                      <FileTimeline
                        repoRoot={repository.repo?.repoRoot ?? null}
                        headSha={repository.status?.headSha ?? null}
                        path={
                          selectedPath && isDirAt(selectedPath) === false
                            ? selectedPath
                            : null
                        }
                        enabled={active !== false && expanded}
                        present={active !== false && present}
                        refreshToken={timelineRefreshToken}
                        onOpenCommitFile={onOpenCommitFile}
                      />
                    ),
                  },
                ]}
              />
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent
            key={menuNonce}
            onCloseAutoFocus={(e) => {
              if (tree.renaming || tree.pendingCreate) e.preventDefault();
            }}
          >
            {menuTarget ? (
              <>
                <FileActionItems
                  onOpenDirectory={onOpenInNewSpace}
                  target={menuTarget}
                  onCopyRelativePath={() =>
                    void copyToClipboard(
                      relativePath(rootPath, menuTarget.path),
                    )
                  }
                  onOpenTerminal={onRevealInTerminal}
                  onOpen={(path) => onOpenFile(path, false)}
                />
                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={() =>
                    clipboard.remember("cut", menuTarget.path, menuTarget.isDir)
                  }
                >
                  {t("menu.cut")}
                  <ContextMenuShortcut>
                    {fmtShortcut(MOD_KEY, "X")}
                  </ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() =>
                    clipboard.remember(
                      "copy",
                      menuTarget.path,
                      menuTarget.isDir,
                    )
                  }
                >
                  {t("menu.copy")}
                  <ContextMenuShortcut>
                    {fmtShortcut(MOD_KEY, "C")}
                  </ContextMenuShortcut>
                </ContextMenuItem>
                {renderPasteActions(
                  menuTarget.isDir
                    ? menuTarget.path
                    : parentOf(menuTarget.path, rootPath),
                )}
                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={() => tree.beginRename(menuTarget.path)}
                >
                  {t("common:rename")}
                </ContextMenuItem>
                <ContextMenuItem
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
                {!menuTarget.isDir && <ContextMenuSeparator />}
                {!menuTarget.isDir &&
                  isPythonFile(menuTarget.path) &&
                  onRunPythonFile && (
                    <ContextMenuItem
                      onSelect={() =>
                        onRunPythonFile(menuTarget.path, rootPath)
                      }
                    >
                      {t("menu.runPythonFile")}
                    </ContextMenuItem>
                  )}
                {!menuTarget.isDir && (
                  <ContextMenuItem
                    onSelect={() => onAttachToAgent?.(menuTarget.path)}
                  >
                    {t("menu.attachToAgent")}
                  </ContextMenuItem>
                )}
                {workspaceEnv.kind !== "local" ? (
                  <>
                    <ContextMenuSeparator />
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
                    {menuTarget.isDir && (
                      <ContextMenuItem
                        onSelect={() => setSyncPath(menuTarget.path)}
                      >
                        {t("sync.title")}
                      </ContextMenuItem>
                    )}
                  </>
                ) : null}
                <ContextMenuSeparator />
                <ContextMenuItem
                  variant="destructive"
                  onSelect={(e) => {
                    if (deleteConfirm) {
                      requestPermanentDelete(menuTarget.path);
                    } else {
                      // Keep the menu open on the first click so the user
                      // can confirm; let it close normally on the second.
                      e.preventDefault();
                      setDeleteConfirm(true);
                    }
                  }}
                >
                  {deleteConfirm ? t("menu.confirmDelete") : t("common:delete")}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={() => requestProperties(menuTarget.path)}
                >
                  {t("menu.properties")}
                </ContextMenuItem>
              </>
            ) : (
              <>
                <FileActionItems
                  onOpenDirectory={onOpenInNewSpace}
                  target={{ path: rootPath, isDir: true }}
                  onOpenTerminal={onRevealInTerminal}
                  onOpen={(path) => onOpenFile(path, false)}
                />
                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={() => tree.beginCreate(rootPath, "file")}
                >
                  {t("menu.newFile")}
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() => tree.beginCreate(rootPath, "dir")}
                >
                  {t("menu.newFolder")}
                </ContextMenuItem>
                {renderPasteActions(rootPath)}
                {workspaceEnv.kind !== "local" && <ContextMenuSeparator />}
                {workspaceEnv.kind !== "local"
                  ? (["files", "folders"] as const).map((kind) => (
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
                    ))
                  : null}
                {workspaceEnv.kind !== "local" && (
                  <ContextMenuItem onSelect={() => setSyncPath(rootPath)}>
                    {t("sync.title")}
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => tree.refresh(rootPath)}>
                  {t("menu.refresh")}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => requestProperties(rootPath)}>
                  {t("menu.properties")}
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>

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
                  requestPermanentDelete(permanentDeleteTarget.path);
                  setPermanentDeleteTarget(null);
                }}
              >
                {t("menu.deletePermanently")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {syncPath && (
          <FolderSyncDialog
            key={syncPath}
            remotePath={syncPath}
            onClose={() => setSyncPath(null)}
          />
        )}
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

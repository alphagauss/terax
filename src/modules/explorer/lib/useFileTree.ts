/**
 * 本文件管理资源管理器文件树的缓存恢复、加载、展开、监听和文件变更操作。
 * 所有系统访问都通过 Tauri IPC，切换根目录时先显示成功缓存并立即校验最新内容。
 */

import {
  type DirEntry,
  readCachedDirectory,
  writeCachedDirectory,
} from "@/modules/explorer/lib/directoryCache";
import {
  retainDirectoryWatch,
  subscribeFileSystemChanges,
  subscribeWorkspaceResume,
} from "@/modules/filesystem";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useRemoteRuntimeStore } from "@/modules/remote";
import {
  useWorkspaceEnvStore,
  workspaceScopeKey,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { isCurrentTreeRequest } from "./requestGuard";
import { documentPathIdentity } from "@/lib/pathIdentity";

export type { DirEntry } from "@/modules/explorer/lib/directoryCache";

type ChildrenState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; entries: DirEntry[] }
  | { status: "error"; message: string };

type TreeState = Record<string, ChildrenState>;
const EMPTY_TREE_STATE: TreeState = {};

export type PendingCreate = {
  parentPath: string;
  kind: "file" | "dir";
};

export type TrashPathResult =
  | { kind: "trashed" }
  | { kind: "unavailable"; reason: string }
  | { kind: "error"; reason: string };

export type DeletePathResult =
  | { kind: "deleted" }
  | { kind: "already-deleting" }
  | { kind: "error"; reason: string };

export function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/")) return `${parent}${name}`;
  return `${parent}/${name}`;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  if (i <= 0) return "/";
  return path.slice(0, i);
}

export function ancestorDirs(root: string, path: string): string[] {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!path.startsWith(prefix)) return [];
  const relativeParent = dirname(path).slice(prefix.length);
  if (!relativeParent) return [];
  const dirs: string[] = [];
  let current = root;
  for (const segment of relativeParent.split("/")) {
    current = joinPath(current, segment);
    dirs.push(current);
  }
  return dirs;
}

const EXPANSION_CACHE_LIMIT = 8;
const expansionCache = new Map<string, string[]>();

function rememberExpansion(root: string, expanded: Set<string>): void {
  expansionCache.delete(root);
  if (expanded.size > 0) expansionCache.set(root, [...expanded]);
  while (expansionCache.size > EXPANSION_CACHE_LIMIT) {
    const oldest = expansionCache.keys().next().value;
    if (oldest === undefined) break;
    expansionCache.delete(oldest);
  }
}

function recallExpansion(root: string): string[] {
  const v = expansionCache.get(root);
  if (!v) return [];
  expansionCache.delete(root);
  expansionCache.set(root, v);
  return v;
}

function isUnder(key: string, root: string): boolean {
  return key === root || key.startsWith(`${root}/`);
}

/** 判断路径是否位于任一正在删除的根路径中。 */
export function isPathDeleting(path: string, deleting: ReadonlySet<string>) {
  for (const root of deleting) {
    if (isUnder(path, root)) return true;
  }
  return false;
}

/** 判断新删除目标是否与现有删除任务的父子范围重叠。 */
export function overlapsDeletingPath(
  path: string,
  deleting: ReadonlySet<string>,
) {
  for (const root of deleting) {
    if (isUnder(path, root) || isUnder(root, path)) return true;
  }
  return false;
}

// mtime/size are ignored on purpose: the tree never renders them, so a watcher
// refetch that only bumps mtime (saving a file) must not count as a change.
function sameDirListing(a: DirEntry[], b: DirEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].name !== b[i].name ||
      a[i].kind !== b[i].kind ||
      a[i].gitignored !== b[i].gitignored
    )
      return false;
  }
  return true;
}

type Options = {
  onPathRenamed?: (from: string, to: string) => void;
  onPathDeleted?: (path: string) => void;
  active?: boolean;
};

export const REMOTE_DIRECTORY_POLL_DELAY_MS = 3_000;

/** 为文件树生成稳定展开域和随 Runtime epoch 变化的请求域。 */
export function fileTreeScopes(
  workspace: WorkspaceEnv,
  rootPath: string | null,
  remoteEpoch: number | null,
): { expansionScope: string; treeScope: string } {
  const expansionScope = `${workspaceScopeKey(workspace)}\0${rootPath ?? ""}`;
  return {
    expansionScope,
    treeScope: `${expansionScope}\0${
      workspace.kind === "ssh" ? (remoteEpoch ?? "offline") : "native"
    }`,
  };
}

/** 返回 SSH 轮询应覆盖的根目录与当前展开目录。 */
export function remoteDirectoryPollPaths(
  rootPath: string,
  expanded: ReadonlySet<string>,
): string[] {
  return [...new Set([rootPath, ...expanded])];
}

/**
 * 管理指定 Workspace 根目录的文件树状态和变更操作。
 *
 * 仅缓存已加载目录；SSH 环境按秒刷新可见节点，所有变更完成后重新读取受影响父目录。
 */
export function useFileTree(rootPath: string | null, options?: Options) {
  const workspace = useWorkspaceEnvStore((state) => state.env);
  const runtime = useRemoteRuntimeStore((state) => state.snapshot);
  const remoteEpoch =
    workspace.kind === "ssh" &&
    runtime.phase === "connected" &&
    runtime.profileId === workspace.profileId
      ? runtime.epoch
      : null;
  const remoteReady = workspace.kind !== "ssh" || remoteEpoch !== null;
  const active = options?.active ?? true;
  const { expansionScope, treeScope } = fileTreeScopes(
    workspace,
    rootPath,
    remoteEpoch,
  );
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const showHiddenRef = useRef(showHidden);
  const gitDecorations = usePreferencesStore((s) => s.explorerGitDecorations);
  const gitDecorationsRef = useRef(gitDecorations);
  const [nodes, setNodes] = useState<TreeState>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(
    null,
  );
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deletingPaths, setDeletingPaths] = useState<Set<string>>(new Set());

  const expandedRef = useRef(expanded);
  const nodesRef = useRef(nodes);
  const deletingPathsRef = useRef(deletingPaths);
  const deletionTokensRef = useRef(new Map<string, symbol>());
  const watchedRef = useRef<Map<string, () => void>>(new Map());
  const requestGenerationRef = useRef(0);
  const requestIdRef = useRef(0);
  const inFlightRef = useRef(new Map<string, number>());
  const pendingRefreshRef = useRef(new Set<string>());
  const activeTreeScopeRef = useRef(treeScope);
  const nodesScopeRef = useRef(treeScope);
  activeTreeScopeRef.current = treeScope;

  useEffect(() => {
    showHiddenRef.current = showHidden;
  }, [showHidden]);

  useEffect(() => {
    gitDecorationsRef.current = gitDecorations;
  }, [gitDecorations]);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    deletingPathsRef.current = deletingPaths;
  }, [deletingPaths]);

  const addWatch = useCallback(
    (path: string) => {
      if (workspace.kind === "ssh" || !active || watchedRef.current.has(path))
        return;
      watchedRef.current.set(path, retainDirectoryWatch(workspace, path));
    },
    [active, workspace],
  );

  const removeWatch = useCallback(
    (path: string) => {
      if (workspace.kind === "ssh") return;
      const release = watchedRef.current.get(path);
      if (!release) return;
      watchedRef.current.delete(path);
      release();
    },
    [workspace.kind],
  );

  const fetchChildren = useCallback(
    async (path: string) => {
      if (!remoteReady) return;
      if (treeScope !== activeTreeScopeRef.current) return;
      if (isPathDeleting(path, deletingPathsRef.current)) return;
      if (inFlightRef.current.has(path)) {
        pendingRefreshRef.current.add(path);
        return;
      }
      const generation = requestGenerationRef.current;
      const requestId = ++requestIdRef.current;
      const request = { scope: treeScope, generation, id: requestId };
      inFlightRef.current.set(path, requestId);
      if (nodesRef.current[path]?.status !== "loaded") {
        setNodes((s) => ({ ...s, [path]: { status: "loading" } }));
      }
      try {
        const entries = await invoke<DirEntry[]>("fs_read_dir", {
          path,
          showHidden: showHiddenRef.current,
          gitDecorations: gitDecorationsRef.current,
          workspace,
        });
        if (
          isPathDeleting(path, deletingPathsRef.current) ||
          !isCurrentTreeRequest(
            request,
            activeTreeScopeRef.current,
            requestGenerationRef.current,
            inFlightRef.current.get(path),
          )
        ) {
          return;
        }

        writeCachedDirectory(
          {
            workspace,
            path,
            showHidden: showHiddenRef.current,
            gitDecorations: gitDecorationsRef.current,
          },
          { entries },
        );

        const prev = nodesRef.current[path];
        if (
          prev?.status === "loaded" &&
          sameDirListing(prev.entries, entries)
        ) {
          return;
        }

        const liveDirs = new Set(
          entries
            .filter((e) => e.kind === "dir")
            .map((e) => joinPath(path, e.name)),
        );
        const removedRoots: string[] = [];
        for (const key of Object.keys(nodesRef.current)) {
          if (dirname(key) === path && !liveDirs.has(key))
            removedRoots.push(key);
        }
        const dead = new Set<string>();
        if (removedRoots.length > 0) {
          const candidates = new Set<string>([
            ...Object.keys(nodesRef.current),
            ...expandedRef.current,
            ...watchedRef.current.keys(),
          ]);
          for (const k of candidates) {
            if (removedRoots.some((r) => isUnder(k, r))) dead.add(k);
          }
        }

        setNodes((s) => {
          const next: TreeState = {};
          for (const [k, v] of Object.entries(s)) if (!dead.has(k)) next[k] = v;
          next[path] = { status: "loaded", entries };
          return next;
        });

        if (dead.size > 0) {
          setExpanded((c) => {
            let changed = false;
            const n = new Set(c);
            for (const d of dead) if (n.delete(d)) changed = true;
            return changed ? n : c;
          });
          for (const d of dead) removeWatch(d);
        }
      } catch (e) {
        if (
          !isCurrentTreeRequest(
            request,
            activeTreeScopeRef.current,
            requestGenerationRef.current,
            inFlightRef.current.get(path),
          )
        ) {
          return;
        }
        setNodes((s) =>
          s[path]?.status === "loaded"
            ? s
            : { ...s, [path]: { status: "error", message: String(e) } },
        );
      } finally {
        if (inFlightRef.current.get(path) === requestId) {
          inFlightRef.current.delete(path);
          // 读取期间的变更不能被吞掉，完成后合并补读一次。
          if (pendingRefreshRef.current.delete(path)) void fetchChildren(path);
        }
      }
    },
    [remoteReady, removeWatch, treeScope, workspace],
  );

  // Root change → restore the cached expansion for this root, re-scope watches,
  // and persist the outgoing root's expansion on the way out.
  useEffect(() => {
    requestGenerationRef.current += 1;
    inFlightRef.current.clear();
    pendingRefreshRef.current.clear();
    nodesScopeRef.current = treeScope;
    if (!rootPath) {
      setNodes({});
      setExpanded(new Set());
      setPendingCreate(null);
      setRenaming(null);
      deletingPathsRef.current = new Set();
      deletionTokensRef.current.clear();
      setDeletingPaths(new Set());
      return;
    }
    setPendingCreate(null);
    setRenaming(null);
    deletingPathsRef.current = new Set();
    deletionTokensRef.current.clear();
    setDeletingPaths(new Set());

    const restored = recallExpansion(expansionScope);
    setExpanded(new Set(restored));
    const cachedNodes: TreeState = {};
    for (const path of new Set([rootPath, ...restored])) {
      const cached = readCachedDirectory({
        workspace,
        path,
        showHidden: showHiddenRef.current,
        gitDecorations: gitDecorationsRef.current,
      });
      if (cached) {
        cachedNodes[path] = { status: "loaded", entries: cached.entries };
      }
    }
    setNodes(cachedNodes);
    // Sync the ref synchronously: nodesRef only updates after the next render,
    // so without this a fast (cached) fetchChildren below would read the stale
    // pre-clear "loaded" node, hit the sameDirListing early-return, and skip
    // re-populating, leaving a valid root with an empty tree when rootPath
    // changes rapidly (e.g. switching folders in quick succession).
    nodesRef.current = cachedNodes;

    if (!remoteReady || !active) {
      return () => {
        rememberExpansion(expansionScope, expandedRef.current);
      };
    }

    void fetchChildren(rootPath);
    for (const d of restored) void fetchChildren(d);
    if (workspace.kind !== "ssh") {
      const toWatch = [rootPath, ...restored];
      for (const path of toWatch) addWatch(path);
    }

    return () => {
      rememberExpansion(expansionScope, expandedRef.current);
      requestGenerationRef.current += 1;
      inFlightRef.current.clear();
      pendingRefreshRef.current.clear();
      for (const release of watchedRef.current.values()) release();
      watchedRef.current.clear();
    };
  }, [
    expansionScope,
    fetchChildren,
    remoteReady,
    active,
    rootPath,
    treeScope,
    addWatch,
    workspace,
  ]);

  useEffect(() => {
    if (workspace.kind === "ssh" || !active || !rootPath) return;
    return subscribeFileSystemChanges(workspace, (paths) => {
      const dirs = new Set<string>();
      for (const p of paths) {
        dirs.add(documentPathIdentity(workspace, dirname(p)));
        dirs.add(documentPathIdentity(workspace, p));
      }
      for (const path of remoteDirectoryPollPaths(
        rootPath,
        expandedRef.current,
      )) {
        if (dirs.has(documentPathIdentity(workspace, path))) {
          void fetchChildren(path);
        }
      }
    });
  }, [active, fetchChildren, rootPath, workspace]);

  useEffect(() => {
    if (!active || !rootPath || workspace.kind === "ssh") return;
    return subscribeWorkspaceResume(() => {
      for (const path of remoteDirectoryPollPaths(
        rootPath,
        expandedRef.current,
      )) {
        void fetchChildren(path);
      }
    });
  }, [active, fetchChildren, rootPath, workspace.kind]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nodes is intentionally omitted so ordinary tree edits do not refetch every expanded directory.
  useEffect(() => {
    if (!rootPath || !active) return;
    const loadedPaths = Object.entries(nodes)
      .filter(([, state]) => state.status === "loaded")
      .map(([path]) => path);
    for (const path of loadedPaths) void fetchChildren(path);
    // Re-list loaded directories when visibility or git-decoration prefs change.
  }, [showHidden, gitDecorations, rootPath, fetchChildren, active]);

  // SFTP 没有通用的服务端推送监听。仅在 Explorer 可见时轮询已展示目录，并从上一轮
  // 完成后再计算等待时间，避免高延迟连接形成持续堆积的请求。
  useEffect(() => {
    if (workspace.kind !== "ssh" || !rootPath || !remoteReady || !active)
      return;
    let disposed = false;
    let running = false;
    let timer: number | null = null;

    const clearTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };
    const schedule = () => {
      clearTimer();
      if (disposed || document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => {
        timer = null;
        void refreshVisibleDirectories();
      }, REMOTE_DIRECTORY_POLL_DELAY_MS);
    };
    const refreshVisibleDirectories = async () => {
      if (disposed || running || document.visibilityState !== "visible") return;
      running = true;
      try {
        const requests = remoteDirectoryPollPaths(
          rootPath,
          expandedRef.current,
        ).map((path) => fetchChildren(path));
        await Promise.all(requests);
      } finally {
        running = false;
        schedule();
      }
    };
    const unsubscribeResume = subscribeWorkspaceResume(() => {
      clearTimer();
      void refreshVisibleDirectories();
    });

    schedule();
    return () => {
      disposed = true;
      clearTimer();
      unsubscribeResume();
    };
  }, [workspace.kind, rootPath, remoteReady, active, fetchChildren]);

  const toggle = useCallback(
    (path: string) => {
      if (isPathDeleting(path, deletingPathsRef.current)) return;
      if (expandedRef.current.has(path)) {
        setExpanded((curr) => {
          const next = new Set(curr);
          next.delete(path);
          return next;
        });
        removeWatch(path);
      } else {
        setExpanded((curr) => {
          const next = new Set(curr);
          next.add(path);
          return next;
        });
        addWatch(path);
        void fetchChildren(path);
      }
    },
    [fetchChildren, addWatch, removeWatch],
  );

  const expand = useCallback(
    (path: string) => {
      if (isPathDeleting(path, deletingPathsRef.current)) return;
      if (expandedRef.current.has(path)) return;
      setExpanded((curr) => {
        const next = new Set(curr);
        next.add(path);
        return next;
      });
      addWatch(path);
      void fetchChildren(path);
    },
    [fetchChildren, addWatch],
  );

  const refresh = useCallback(
    (path: string) => {
      void fetchChildren(path);
    },
    [fetchChildren],
  );

  const collapseAll = useCallback(() => {
    if (expandedRef.current.size === 0) return;

    expandedRef.current = new Set();
    setExpanded(new Set());

    const toUnwatch = [...watchedRef.current.keys()].filter(
      (path) => path !== rootPath,
    );
    for (const path of toUnwatch) removeWatch(path);
  }, [removeWatch, rootPath]);

  // --- mutations ---

  const beginDelete = useCallback((path: string) => {
    if (overlapsDeletingPath(path, deletingPathsRef.current)) return null;
    const token = Symbol(path);
    const next = new Set(deletingPathsRef.current);
    next.add(path);
    deletionTokensRef.current.set(path, token);
    deletingPathsRef.current = next;
    setDeletingPaths(next);
    setRenaming((current) =>
      current && isUnder(current, path) ? null : current,
    );
    setPendingCreate((current) =>
      current && isUnder(current.parentPath, path) ? null : current,
    );
    return token;
  }, []);

  const endDelete = useCallback((path: string, token: symbol) => {
    if (deletionTokensRef.current.get(path) !== token) return;
    deletionTokensRef.current.delete(path);
    const next = new Set(deletingPathsRef.current);
    next.delete(path);
    deletingPathsRef.current = next;
    setDeletingPaths(next);
  }, []);

  const beginCreate = useCallback(
    (parentPath: string, kind: "file" | "dir") => {
      setRenaming(null);
      setPendingCreate({ parentPath, kind });
      // Ensure the parent is expanded so the input row is visible.
      if (rootPath && parentPath !== rootPath) {
        setExpanded((curr) => {
          if (curr.has(parentPath)) return curr;
          const next = new Set(curr);
          next.add(parentPath);
          return next;
        });
        addWatch(parentPath);
      }
      setNodes((curr) => {
        if (!curr[parentPath]) void fetchChildren(parentPath);
        return curr;
      });
    },
    [rootPath, fetchChildren, addWatch],
  );

  const cancelCreate = useCallback(() => setPendingCreate(null), []);

  const commitCreate = useCallback(
    async (name: string) => {
      if (!pendingCreate) return;
      const trimmed = name.trim();
      if (!trimmed) {
        setPendingCreate(null);
        return;
      }
      const path = joinPath(pendingCreate.parentPath, trimmed);
      const cmd =
        pendingCreate.kind === "dir" ? "fs_create_dir" : "fs_create_file";
      try {
        await invoke(cmd, { path, workspace });
        await fetchChildren(pendingCreate.parentPath);
      } catch (e) {
        console.error(`${cmd} failed:`, e);
      } finally {
        setPendingCreate(null);
      }
    },
    [pendingCreate, fetchChildren, workspace],
  );

  const beginRename = useCallback((path: string) => {
    setPendingCreate(null);
    setRenaming(path);
  }, []);

  const cancelRename = useCallback(() => setRenaming(null), []);

  const commitRename = useCallback(
    async (newName: string) => {
      if (!renaming) return;
      const trimmed = newName.trim();
      const parent = dirname(renaming);
      const oldName = renaming.slice(parent === "/" ? 1 : parent.length + 1);
      if (!trimmed || trimmed === oldName) {
        setRenaming(null);
        return;
      }
      const to = joinPath(parent, trimmed);
      try {
        await invoke("fs_rename", {
          from: renaming,
          to,
          workspace,
        });
        options?.onPathRenamed?.(renaming, to);
        await fetchChildren(parent);
      } catch (e) {
        console.error("fs_rename failed:", e);
      } finally {
        setRenaming(null);
      }
    },
    [renaming, fetchChildren, options, workspace],
  );

  const deletePath = useCallback(
    async (path: string): Promise<DeletePathResult> => {
      const token = beginDelete(path);
      if (!token) return { kind: "already-deleting" };
      try {
        await invoke("fs_delete", { path, workspace });
        options?.onPathDeleted?.(path);
        await fetchChildren(dirname(path));
        return { kind: "deleted" };
      } catch (e) {
        console.error("fs_delete failed:", e);
        // 远端递归删除可能在权限错误前已删除部分内容，失败后也刷新父目录。
        await fetchChildren(dirname(path));
        return { kind: "error", reason: String(e) };
      } finally {
        endDelete(path, token);
      }
    },
    [beginDelete, endDelete, fetchChildren, options, workspace],
  );

  const trashPath = useCallback(
    async (path: string): Promise<TrashPathResult> => {
      const token = beginDelete(path);
      if (!token) {
        return { kind: "error", reason: "path is already being deleted" };
      }
      try {
        const result = await invoke<TrashPathResult>("fs_trash", {
          path,
          workspace,
        });
        if (result.kind !== "trashed") return result;
        options?.onPathDeleted?.(path);
        await fetchChildren(dirname(path));
        return result;
      } catch (e) {
        await fetchChildren(dirname(path));
        return { kind: "error", reason: String(e) };
      } finally {
        endDelete(path, token);
      }
    },
    [beginDelete, endDelete, fetchChildren, options, workspace],
  );

  const movePath = useCallback(
    async (from: string, toDir: string) => {
      const name = from.slice(from.lastIndexOf("/") + 1);
      const to = joinPath(toDir, name);
      if (to === from) return;
      const target = nodesRef.current[toDir];
      if (
        target?.status === "loaded" &&
        target.entries.some((e) => e.name === name)
      ) {
        console.warn(`move skipped: "${name}" already exists in ${toDir}`);
        return;
      }
      try {
        await invoke("fs_rename", {
          from,
          to,
          workspace,
        });
        options?.onPathRenamed?.(from, to);
        await Promise.all([fetchChildren(dirname(from)), fetchChildren(toDir)]);
      } catch (e) {
        console.error("fs_rename (move) failed:", e);
      }
    },
    [fetchChildren, options, workspace],
  );

  return {
    remoteReady,
    nodes: nodesScopeRef.current === treeScope ? nodes : EMPTY_TREE_STATE,
    expanded,
    deletingPaths,
    pendingCreate,
    renaming,
    toggle,
    expand,
    refresh,
    collapseAll,
    beginCreate,
    cancelCreate,
    commitCreate,
    beginRename,
    cancelRename,
    commitRename,
    deletePath,
    trashPath,
    movePath,
    joinPath,
  };
}

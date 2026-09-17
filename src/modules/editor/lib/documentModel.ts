/**
 * 本文件管理跨编辑器视图共享的文档缓冲区、磁盘协调和自动保存。
 *
 * 同一路径的视图共享内容版本与保存队列。冲突只由内容版本判定，通知仅展示模型状态。
 */

import i18n from "@/i18n";
import { documentResourceKey } from "@/lib/pathIdentity";
import { notifyDocumentSaved } from "@/modules/lsp";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { WorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { detectEol, type Eol, normalizeToLf, restoreEol } from "./eol";

type TextReadResult = {
  kind: "text";
  content: string;
  size: number;
  mtime: number;
  revision: string;
};

type ReadResult =
  | TextReadResult
  | { kind: "binary"; size: number; mtime: number }
  | { kind: "toolarge"; size: number; limit: number; mtime: number };

type FileVersion = {
  revision: string;
  size: number;
  mtime: number;
};

type ObservedMetadata = {
  size: number;
  mtime: number;
};

type CheckedWriteResult =
  | { status: "written"; revision: string; size: number; mtime: number }
  | { status: "conflict"; current: ObservedMetadata | null };

type WriteCondition =
  | { type: "match"; version: FileVersion }
  | { type: "overwrite" };

type FileStat = { size: number; mtime: number; kind: string };

type DiskText = {
  content: string;
  eol: Eol;
  size: number;
  mtime: number;
  revision: string;
};

/** 与 Rust 文件读取层的强制打开上限保持一致。 */
export const FORCE_READ_LIMIT = 50 * 1024 * 1024;

type DocumentState =
  | { status: "loading" }
  | { status: "ready"; content: string; size: number }
  | { status: "binary"; size: number }
  | { status: "toolarge"; size: number; limit: number }
  | { status: "error"; message: string };

type DocumentSnapshot = {
  doc: DocumentState;
  dirty: boolean;
  baselineContent: string;
  /** 当前文档在 HEAD 中的文本；null 表示无法提供 Quick Diff。 */
  gitBaseline: string | null;
};

type DocumentUpdate = Omit<DocumentSnapshot, "gitBaseline"> & {
  gitBaseline?: string | null;
};

type GitBaselineResult =
  | {
      kind: "text";
      repoRoot: string;
      relativePath: string;
      headSha: string | null;
      content: string;
    }
  | { kind: "unsupported" };

type Listener = () => void;
type ReloadMode = "none" | "probe" | "full";

const REMOTE_POLL_MS = 3000;
const REMOTE_DIGEST_POLL_MS = 30_000;
const MODEL_DISPOSE_DELAY_MS = 30_000;
const REMOTE_POLL_CONCURRENCY = 8;
const REMOTE_DIGEST_POLL_COUNT = Math.ceil(
  REMOTE_DIGEST_POLL_MS / REMOTE_POLL_MS,
);

/** 组合 Quick Diff 基线的仓库与提交身份，避免相同 SHA 的不同仓库共享缓存。 */
function gitBaselineKey(repoRoot: string, headSha: string | null): string {
  return `${repoRoot}\0${headSha ?? ""}`;
}

const models = new Map<string, SharedDocumentModel>();
let remotePollTimer: ReturnType<typeof setInterval> | null = null;
let remotePollInFlight = false;

/** 只在存在已订阅的 SSH 文档时维持一个进程级轮询定时器。 */
function syncRemotePolling(): void {
  const active = [...models.values()].some((model) =>
    model.hasRemoteSubscribers(),
  );
  if (!active) {
    if (remotePollTimer) clearInterval(remotePollTimer);
    remotePollTimer = null;
    return;
  }
  if (remotePollTimer) return;
  remotePollTimer = setInterval(
    () => void pollRemoteDocuments(),
    REMOTE_POLL_MS,
  );
}

/** 分批探测活跃 SSH 文档，限制瞬时 IPC 与远端请求并发。 */
async function pollRemoteDocuments(): Promise<void> {
  if (
    remotePollInFlight ||
    (typeof document !== "undefined" && document.visibilityState === "hidden")
  )
    return;
  remotePollInFlight = true;
  try {
    const now = Date.now();
    const active = [...models.values()].filter((model) =>
      model.shouldPollRemote(now),
    );
    for (
      let index = 0;
      index < active.length;
      index += REMOTE_POLL_CONCURRENCY
    ) {
      await Promise.all(
        active
          .slice(index, index + REMOTE_POLL_CONCURRENCY)
          .map((model) => model.pollRemote()),
      );
    }
  } finally {
    remotePollInFlight = false;
  }
}

/** 将原生文本读取结果转换为编辑器内部统一的磁盘快照。 */
function toDiskText(result: TextReadResult): DiskText {
  return {
    content: normalizeToLf(result.content),
    eol: detectEol(result.content),
    size: result.size,
    mtime: result.mtime,
    revision: result.revision,
  };
}

export { documentResourceKey } from "@/lib/pathIdentity";

/** 获取工作区内指定路径的共享文档模型。 */
export function getSharedDocumentModel(
  workspace: WorkspaceEnv,
  path: string,
): SharedDocumentModel {
  const key = documentResourceKey(workspace, path);
  const existing = models.get(key);
  if (existing) return existing;
  const model = new SharedDocumentModel(key, workspace, path);
  models.set(key, model);
  return model;
}

export function discardSharedDocumentModel(
  workspace: WorkspaceEnv,
  path: string,
): void {
  models.get(documentResourceKey(workspace, path))?.discard();
}

/**
 * 应用主动关闭前立即保存所有已启用自动保存的脏文档。
 *
 * 文件冲突会作为失败返回关闭流程，避免未经用户确认覆盖磁盘内容。
 */
export async function saveAutoSaveDocumentsBeforeClose(): Promise<boolean> {
  if (!usePreferencesStore.getState().editorAutoSave) return false;
  while (true) {
    const dirtyModels = [...models.values()].filter(
      (model) => model.getSnapshot().dirty,
    );
    if (dirtyModels.length === 0) return true;
    await Promise.all(dirtyModels.map((model) => model.saveBeforeClose()));
  }
}

class SharedDocumentModel {
  private snapshot: DocumentSnapshot = {
    doc: { status: "loading" },
    dirty: false,
    baselineContent: "",
    gitBaseline: null,
  };
  private readonly listeners = new Set<Listener>();
  private started = false;
  private readGeneration = 0;
  private savedBuffer = "";
  private buffer = "";
  private eol: Eol = "\n";
  private base: FileVersion | null = null;
  private observed: ObservedMetadata | null = null;
  // undefined 表示无冲突，null 表示磁盘内容无法作为文本协调。
  private conflictDisk: DiskText | null | undefined;
  private forceRead = false;
  private reloadRequested: ReloadMode = "none";
  private autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private disposeTimer: ReturnType<typeof setTimeout> | null = null;
  private savePromise: Promise<boolean> | null = null;
  private reloadPromise: Promise<void> | null = null;
  private unchangedRemotePolls = 0;
  private lastRemotePollAt = 0;
  private activationCheckPending = false;
  private readonly remotePollOwners = new Map<symbol, boolean>();
  private gitBaselineGeneration = 0;
  private gitBaselineLoadedKey: string | null = null;
  private gitBaselinePromise: Promise<void> | null = null;
  private gitBaselineRequestedKey: string | null = null;

  constructor(
    private readonly key: string,
    private readonly workspace: WorkspaceEnv,
    private readonly path: string,
  ) {}

  getSnapshot = (): DocumentSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.cancelDisposal();
    this.listeners.add(listener);
    if (!this.started) {
      this.started = true;
      void this.loadInitial(false);
    }
    syncRemotePolling();

    return () => {
      this.listeners.delete(listener);
      syncRemotePolling();
      if (this.listeners.size === 0) this.scheduleDisposal();
    };
  };

  /** 接收编辑器内容变化，并根据当前冲突状态安排协调或自动保存。 */
  onChange = (next: string): void => {
    if (next === this.buffer) return;
    this.buffer = next;

    const conflictDisk = this.conflictDisk;
    if (
      conflictDisk &&
      (next === this.savedBuffer || next === conflictDisk.content)
    ) {
      this.adoptDisk(conflictDisk);
      return;
    }

    const dirty = next !== this.savedBuffer;
    const doc =
      this.snapshot.doc.status === "ready"
        ? { ...this.snapshot.doc, content: next }
        : this.snapshot.doc;
    this.publish({
      doc,
      dirty,
      baselineContent: this.snapshot.baselineContent,
    });

    this.clearAutoSaveTimer();
    if (this.conflictDisk !== undefined) {
      if (!dirty) this.reload();
      return;
    }
    this.scheduleAutoSave();
  };

  /** 使用当前磁盘内容版本保存缓冲区，版本冲突时保持本地内容不变。 */
  save = async (): Promise<boolean> => {
    this.clearAutoSaveTimer();
    if (this.buffer === this.savedBuffer) return true;
    if (this.savePromise) {
      const saved = await this.savePromise;
      if (!saved || this.buffer === this.savedBuffer) return saved;
    }
    return this.saveNow(false);
  };

  /** 保存关闭时仍为脏状态的最新缓冲区，并将冲突转换为可展示的失败原因。 */
  async saveBeforeClose(): Promise<void> {
    while (this.snapshot.dirty) {
      const saved = await this.save();
      if (saved) continue;
      const name = this.path.split(/[\\/]/).pop() ?? this.path;
      throw new Error(i18n.t("editor:closeAutoSaveConflict", { name }));
    }
  }

  /** 请求从磁盘协调最新内容；连续事件会合并，但不会丢失读取期间的新请求。 */
  reload = (): void => this.requestReload("full");

  /** 先在数据源端核对摘要，只有内容变化时才读取正文。 */
  checkForChanges = (): void =>
    this.requestReload(this.base ? "probe" : "full");

  /** 前台激活或窗口恢复后核对磁盘；初次读取期间的请求在读取完成后补做。 */
  revalidateAfterActivation = (): void => {
    if (this.snapshot.doc.status === "loading") {
      this.activationCheckPending = true;
      return;
    }
    this.activationCheckPending = false;
    this.checkForChanges();
  };

  /** 合并并串行执行协调请求，完整读取优先于仅探测版本。 */
  private requestReload(mode: Exclude<ReloadMode, "none">): void {
    if (mode === "full" || this.reloadRequested === "none") {
      this.reloadRequested = mode;
    }
    if (this.reloadPromise || this.savePromise) return;
    const pending = this.runReloads().finally(() => {
      if (this.reloadPromise !== pending) return;
      this.reloadPromise = null;
      if (this.reloadRequested !== "none") {
        this.requestReload(this.reloadRequested);
      }
    });
    this.reloadPromise = pending;
  }

  openAnyway = (): void => {
    this.forceRead = true;
    void this.loadInitial(true);
  };

  /** 仓库或 HEAD 变化时刷新共享 Quick Diff 基线，相同资源版本不重复执行 IPC。 */
  syncGitBaseline = (repoRoot: string, headSha: string | null): void => {
    const requestedKey = gitBaselineKey(repoRoot, headSha);
    if (this.gitBaselineLoadedKey === requestedKey) return;
    if (
      this.gitBaselinePromise &&
      this.gitBaselineRequestedKey === requestedKey
    ) {
      return;
    }
    this.gitBaselineLoadedKey = null;
    this.publish({
      doc: this.snapshot.doc,
      dirty: this.snapshot.dirty,
      baselineContent: this.snapshot.baselineContent,
      gitBaseline: null,
    });
    this.gitBaselineRequestedKey = requestedKey;
    const pending = this.loadGitBaseline().finally(() => {
      if (this.gitBaselinePromise === pending) this.gitBaselinePromise = null;
    });
    this.gitBaselinePromise = pending;
  };

  /** 采用由 Terax 主动执行的外部格式化结果，并返回编辑器使用的 LF 内容。 */
  adoptFormattedDiskText = (
    diskText: string,
    revision: string,
    size: number,
    mtime: number,
  ): string => {
    const disk: DiskText = {
      content: normalizeToLf(diskText),
      eol: detectEol(diskText),
      revision,
      size,
      mtime,
    };
    this.eol = disk.eol;
    this.base = disk;
    this.observed = disk;
    this.savedBuffer = disk.content;
    this.resolveConflict();
    const doc =
      this.snapshot.doc.status === "ready"
        ? { ...this.snapshot.doc, size: disk.size }
        : this.snapshot.doc;
    this.publish({
      doc,
      dirty: this.buffer !== disk.content,
      baselineContent: disk.content,
    });
    return disk.content;
  };

  disposeForTests(): void {
    this.discard();
  }

  discard(): void {
    if (models.get(this.key) === this) models.delete(this.key);
    this.listeners.clear();
    this.remotePollOwners.clear();
    this.clearAutoSaveTimer();
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = null;
    this.readGeneration += 1;
    this.gitBaselineGeneration += 1;
    this.reloadRequested = "none";
    if (this.conflictDisk !== undefined) toast.dismiss(this.conflictToastId());
    syncRemotePolling();
  }

  private publish(update: DocumentUpdate): void {
    const next: DocumentSnapshot = {
      ...update,
      gitBaseline:
        update.gitBaseline === undefined
          ? this.snapshot.gitBaseline
          : update.gitBaseline,
    };
    if (
      next.doc === this.snapshot.doc &&
      next.dirty === this.snapshot.dirty &&
      next.baselineContent === this.snapshot.baselineContent &&
      next.gitBaseline === this.snapshot.gitBaseline
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  /** 读取当前文档唯一的 HEAD 文本基线，并丢弃过期请求。 */
  private async loadGitBaseline(): Promise<void> {
    const generation = ++this.gitBaselineGeneration;
    try {
      const result = await invoke<GitBaselineResult>(
        "git_quick_diff_baseline",
        { path: this.path, workspace: this.workspace },
      );
      if (generation !== this.gitBaselineGeneration) return;
      this.gitBaselineLoadedKey =
        result.kind === "text"
          ? gitBaselineKey(result.repoRoot, result.headSha)
          : null;
      this.publish({
        doc: this.snapshot.doc,
        dirty: this.snapshot.dirty,
        baselineContent: this.snapshot.baselineContent,
        gitBaseline: result.kind === "text" ? result.content : null,
      });
    } catch {
      if (generation !== this.gitBaselineGeneration) return;
      this.gitBaselineLoadedKey = null;
      this.publish({
        doc: this.snapshot.doc,
        dirty: this.snapshot.dirty,
        baselineContent: this.snapshot.baselineContent,
        gitBaseline: null,
      });
    }
  }

  private async loadInitial(showLoading: boolean): Promise<void> {
    const generation = ++this.readGeneration;
    if (showLoading) {
      this.publish({
        doc: { status: "loading" },
        dirty: false,
        baselineContent: this.snapshot.baselineContent,
      });
    }
    try {
      const result = await this.readDisk();
      if (generation !== this.readGeneration) return;
      this.adoptInitialRead(result);
    } catch (error) {
      if (generation !== this.readGeneration) return;
      this.publish({
        doc: { status: "error", message: String(error) },
        dirty: false,
        baselineContent: this.snapshot.baselineContent,
      });
    } finally {
      if (generation === this.readGeneration && this.activationCheckPending) {
        this.activationCheckPending = false;
        this.checkForChanges();
      }
    }
  }

  private async runReloads(): Promise<void> {
    do {
      const mode = this.reloadRequested;
      this.reloadRequested = "none";
      const generation = ++this.readGeneration;
      try {
        if (mode === "probe") {
          const version = await this.readVersion().catch(() => undefined);
          if (generation !== this.readGeneration) continue;
          if (version && this.base?.revision === version.revision) {
            this.adoptBaseVersion(version);
            continue;
          }
          if (version === null && this.snapshot.dirty) {
            this.observed = null;
            this.enterConflict(null);
            continue;
          }
        }
        const result = await this.readDisk();
        if (generation === this.readGeneration) this.reconcileRead(result);
      } catch (error) {
        if (generation === this.readGeneration) {
          console.warn("[editor] reload failed", this.path, error);
        }
      }
    } while (this.reloadRequested !== "none");
  }

  private readVersion(): Promise<FileVersion | null> {
    return invoke<FileVersion | null>("fs_file_version", {
      path: this.path,
      workspace: this.workspace,
    });
  }

  private readDisk(): Promise<ReadResult> {
    return invoke<ReadResult>("fs_read_file", {
      path: this.path,
      workspace: this.workspace,
      force: this.forceRead,
    });
  }

  /** 以 base、local、disk 三方关系协调磁盘读取结果。 */
  private reconcileRead(result: ReadResult): void {
    if (this.base === null) {
      this.adoptInitialRead(result);
      return;
    }
    if (result.kind !== "text") {
      this.observed = result;
      if (this.buffer === this.savedBuffer) this.adoptNonText(result);
      else this.enterConflict(null);
      return;
    }

    const disk = toDiskText(result);
    if (disk.revision === this.base.revision) {
      this.adoptBaseVersion(disk);
      return;
    }
    if (disk.content === this.savedBuffer) {
      this.eol = disk.eol;
      this.base = disk;
      this.observed = disk;
      this.resolveConflict();
      const doc =
        this.snapshot.doc.status === "ready"
          ? { ...this.snapshot.doc, size: disk.size }
          : this.snapshot.doc;
      this.publish({
        doc,
        dirty: this.buffer !== this.savedBuffer,
        baselineContent: this.savedBuffer,
      });
      this.scheduleAutoSave();
      return;
    }
    if (this.buffer === this.savedBuffer || disk.content === this.buffer) {
      this.adoptDisk(disk);
      return;
    }
    this.enterConflict(disk);
  }

  private adoptBaseVersion(version: FileVersion): void {
    this.base = version;
    this.observed = version;
    this.resolveConflict();
    const doc =
      this.snapshot.doc.status === "ready"
        ? { ...this.snapshot.doc, size: version.size }
        : this.snapshot.doc;
    this.publish({
      doc,
      dirty: this.buffer !== this.savedBuffer,
      baselineContent: this.savedBuffer,
    });
    this.scheduleAutoSave();
  }

  private adoptInitialRead(result: ReadResult): void {
    if (result.kind === "text") {
      this.adoptDisk(toDiskText(result));
      return;
    }
    this.adoptNonText(result);
  }

  private adoptDisk(disk: DiskText): void {
    this.eol = disk.eol;
    this.base = disk;
    this.observed = disk;
    this.savedBuffer = disk.content;
    this.buffer = disk.content;
    this.resolveConflict();
    this.clearAutoSaveTimer();
    this.publish({
      doc: { status: "ready", content: disk.content, size: disk.size },
      dirty: false,
      baselineContent: disk.content,
    });
  }

  private adoptNonText(result: Exclude<ReadResult, TextReadResult>): void {
    this.base = null;
    this.observed = result;
    this.resolveConflict();
    this.clearAutoSaveTimer();
    this.publish({
      doc:
        result.kind === "binary"
          ? { status: "binary", size: result.size }
          : {
              status: "toolarge",
              size: result.size,
              limit: result.limit,
            },
      dirty: false,
      baselineContent: this.snapshot.baselineContent,
    });
  }

  private saveNow(force: boolean): Promise<boolean> {
    if (this.savePromise) return this.savePromise;
    this.clearAutoSaveTimer();
    const pending = this.writeToDisk(force).finally(() => {
      if (this.savePromise !== pending) return;
      this.savePromise = null;
      if (this.reloadRequested !== "none") {
        this.requestReload(this.reloadRequested);
      }
    });
    this.savePromise = pending;
    return pending;
  }

  private async writeToDisk(force: boolean): Promise<boolean> {
    const content = this.buffer;
    const diskContent = restoreEol(content, this.eol);
    let condition: WriteCondition;
    if (force) {
      condition = { type: "overwrite" };
    } else {
      if (!this.base) throw new Error("document has no writable base version");
      condition = { type: "match", version: this.base };
    }
    const result = await invoke<CheckedWriteResult>("fs_write_file_checked", {
      path: this.path,
      content: diskContent,
      condition,
      workspace: this.workspace,
      source: "editor",
    });
    if (result.status === "conflict") {
      const wasConflicted = this.conflictDisk !== undefined;
      this.observed = result.current;
      if (wasConflicted) this.showConflict();
      else this.enterConflict(null);
      return false;
    }

    this.eol = detectEol(diskContent);
    this.base = result;
    this.observed = result;
    this.savedBuffer = content;
    this.resolveConflict();
    const dirty = this.buffer !== content;
    const doc =
      this.snapshot.doc.status === "ready"
        ? {
            ...this.snapshot.doc,
            content: this.buffer,
            size: result.size,
          }
        : this.snapshot.doc;
    this.publish({ doc, dirty, baselineContent: content });
    notifyDocumentSaved(this.path);
    this.scheduleAutoSave();
    if (this.listeners.size === 0) this.scheduleDisposal();
    return true;
  }

  private enterConflict(disk: DiskText | null): void {
    const wasConflicted = this.conflictDisk !== undefined;
    this.conflictDisk = disk;
    if (disk) {
      this.observed = disk;
    }
    this.clearAutoSaveTimer();
    if (!wasConflicted) this.showConflict();
  }

  private resolveConflict(): void {
    if (this.conflictDisk === undefined) return;
    this.conflictDisk = undefined;
    toast.dismiss(this.conflictToastId());
  }

  private showConflict(): void {
    const name = this.path.split(/[\\/]/).pop() ?? this.path;
    toast.warning(i18n.t("editor:saveConflict.title"), {
      id: this.conflictToastId(),
      duration: Infinity,
      description: i18n.t("editor:saveConflict.description", { name }),
      action: {
        label: i18n.t("editor:saveConflict.overwrite"),
        onClick: () => void this.confirmOverwrite(),
      },
    });
  }

  private async confirmOverwrite(): Promise<void> {
    try {
      if (this.savePromise) await this.savePromise;
      await this.saveNow(true);
    } catch (error) {
      toast.error(i18n.t("editor:saveFailed"), {
        description: String(error),
      });
      this.showConflict();
    }
  }

  private conflictToastId(): string {
    return `save-conflict:${this.key}`;
  }

  /** 返回当前模型是否仍有需要远端一致性的订阅者。 */
  hasRemoteSubscribers(): boolean {
    return (
      this.workspace.kind === "ssh" &&
      this.listeners.size > 0 &&
      [...this.remotePollOwners.values()].some(Boolean)
    );
  }

  /** 更新一个视图是否处于前台，多个可见视图共享最高轮询优先级。 */
  setRemotePollingActive(owner: symbol, active: boolean): void {
    this.remotePollOwners.set(owner, active);
    syncRemotePolling();
  }

  clearRemotePollingOwner(owner: symbol): void {
    this.remotePollOwners.delete(owner);
    syncRemotePolling();
  }

  /** 仅为前台订阅者按固定周期探测远端。 */
  shouldPollRemote(now: number): boolean {
    if (!this.hasRemoteSubscribers()) return false;
    return now - this.lastRemotePollAt >= REMOTE_POLL_MS;
  }

  /** 使用元数据快路径轮询远端，并以低频摘要兜底秒级时间戳碰撞。 */
  async pollRemote(): Promise<void> {
    this.lastRemotePollAt = Date.now();
    const stat = await invoke<FileStat>("fs_stat", {
      path: this.path,
      workspace: this.workspace,
    }).catch(() => null);
    if (!stat) return;
    const unchanged =
      this.observed &&
      stat.mtime === this.observed.mtime &&
      stat.size === this.observed.size;
    if (unchanged) {
      if (this.conflictDisk !== undefined) {
        this.unchangedRemotePolls = 0;
        return;
      }
      this.unchangedRemotePolls += 1;
      if (this.unchangedRemotePolls < REMOTE_DIGEST_POLL_COUNT) return;
    }
    this.unchangedRemotePolls = 0;
    if (unchanged) this.checkForChanges();
    else this.reload();
  }

  private scheduleAutoSave(): void {
    const preferences = usePreferencesStore.getState();
    if (
      this.autoSaveTimer ||
      this.conflictDisk !== undefined ||
      !this.snapshot.dirty ||
      !preferences.editorAutoSave
    ) {
      return;
    }
    this.autoSaveTimer = setTimeout(() => {
      this.autoSaveTimer = null;
      void this.save().catch((error) => console.error("[autosave]", error));
    }, preferences.editorAutoSaveDelay);
  }

  private clearAutoSaveTimer(): void {
    if (!this.autoSaveTimer) return;
    clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = null;
  }

  private scheduleDisposal(): void {
    if (this.disposeTimer) return;
    if (!this.snapshot.dirty) this.clearAutoSaveTimer();
    this.disposeTimer = setTimeout(() => {
      this.disposeTimer = null;
      if (this.listeners.size > 0) return;
      if (this.snapshot.dirty) return;
      this.discard();
    }, MODEL_DISPOSE_DELAY_MS);
  }

  private cancelDisposal(): void {
    if (!this.disposeTimer) return;
    clearTimeout(this.disposeTimer);
    this.disposeTimer = null;
  }
}

/** 清理测试进程中的共享文档和轮询资源。 */
export function resetSharedDocumentModelsForTests(): void {
  for (const model of [...models.values()]) {
    model.disposeForTests();
  }
  models.clear();
}

import { documentResourceKey } from "@/lib/pathIdentity";
import i18n from "@/i18n";
import { notifyDocumentSaved } from "@/modules/lsp";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { WorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { detectEol, type Eol, normalizeToLf, restoreEol } from "./eol";
import { fileFingerprintChanged } from "./remotePolling";

type ReadResult =
  | { kind: "text"; content: string; size: number; mtime: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type FileStat = { size: number; mtime: number; kind: string };

/// Mirrors FORCE_MAX_READ_BYTES in src-tauri fs/file.rs.
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
};

type Listener = () => void;

const REMOTE_POLL_MS = 3000;
const MODEL_DISPOSE_DELAY_MS = 30_000;

const models = new Map<string, SharedDocumentModel>();

export { documentResourceKey } from "@/lib/pathIdentity";

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

class SharedDocumentModel {
  private snapshot: DocumentSnapshot = {
    doc: { status: "loading" },
    dirty: false,
    baselineContent: "",
  };
  private readonly listeners = new Set<Listener>();
  private started = false;
  private readGeneration = 0;
  private savedBuffer = "";
  private buffer = "";
  private eol: Eol = "\n";
  private diskMtime: number | null = null;
  private diskSize: number | null = null;
  private forceRead = false;
  private autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private remotePollTimer: ReturnType<typeof setInterval> | null = null;
  private disposeTimer: ReturnType<typeof setTimeout> | null = null;
  private savePromise: Promise<boolean> | null = null;
  private reloadPromise: Promise<void> | null = null;

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
      void this.load(false, false);
    }
    this.startRemotePolling();

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.scheduleDisposal();
    };
  };

  onChange = (next: string): void => {
    if (next === this.buffer) return;
    this.buffer = next;
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
    const preferences = usePreferencesStore.getState();
    if (preferences.editorAutoSave && dirty) {
      this.autoSaveTimer = setTimeout(() => {
        this.autoSaveTimer = null;
        void this.save().catch((error) => console.error("[autosave]", error));
      }, preferences.editorAutoSaveDelay);
    }
  };

  save = async (): Promise<boolean> => {
    this.clearAutoSaveTimer();
    if (this.buffer === this.savedBuffer) return true;
    if (this.savePromise) {
      const saved = await this.savePromise;
      if (!saved || this.buffer === this.savedBuffer) return saved;
    }
    return this.saveNow();
  };

  reload = (): boolean => {
    if (this.snapshot.dirty) return false;
    if (!this.reloadPromise) {
      const pending = this.load(this.forceRead, false, true).finally(() => {
        if (this.reloadPromise === pending) this.reloadPromise = null;
      });
      this.reloadPromise = pending;
    }
    return true;
  };

  openAnyway = (): void => {
    this.forceRead = true;
    void this.load(true, true);
  };

  adoptDiskText = (diskText: string, mtime: number): string => {
    this.eol = detectEol(diskText);
    this.diskMtime = mtime;
    this.diskSize = new TextEncoder().encode(diskText).byteLength;
    const content = normalizeToLf(diskText);
    this.savedBuffer = content;
    this.publish({
      doc: this.snapshot.doc,
      dirty: this.buffer !== content,
      baselineContent: content,
    });
    return content;
  };

  disposeForTests(): void {
    this.discard();
  }

  discard(): void {
    if (models.get(this.key) === this) models.delete(this.key);
    this.listeners.clear();
    this.clearAutoSaveTimer();
    if (this.remotePollTimer) clearInterval(this.remotePollTimer);
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.remotePollTimer = null;
    this.disposeTimer = null;
    this.readGeneration += 1;
  }

  private publish(next: DocumentSnapshot): void {
    if (
      next.doc === this.snapshot.doc &&
      next.dirty === this.snapshot.dirty &&
      next.baselineContent === this.snapshot.baselineContent
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  private async load(
    force: boolean,
    showLoading: boolean,
    skipIfUnchanged = false,
  ): Promise<void> {
    const generation = ++this.readGeneration;
    if (showLoading) {
      this.publish({
        doc: { status: "loading" },
        dirty: false,
        baselineContent: this.snapshot.baselineContent,
      });
    }
    try {
      const result = await invoke<ReadResult>("fs_read_file", {
        path: this.path,
        workspace: this.workspace,
        force,
      });
      if (generation !== this.readGeneration || this.snapshot.dirty) return;
      this.adoptRead(result, skipIfUnchanged);
    } catch (error) {
      if (generation !== this.readGeneration) return;
      if (skipIfUnchanged) {
        console.warn("[editor] reload failed", this.path, error);
        return;
      }
      this.publish({
        doc: { status: "error", message: String(error) },
        dirty: false,
        baselineContent: this.snapshot.baselineContent,
      });
    }
  }

  private adoptRead(result: ReadResult, skipIfUnchanged: boolean): void {
    if (result.kind === "text") {
      this.eol = detectEol(result.content);
      this.diskMtime = result.mtime;
      this.diskSize = result.size;
      const content = normalizeToLf(result.content);
      if (skipIfUnchanged && content === this.savedBuffer) return;
      this.savedBuffer = content;
      this.buffer = content;
      this.publish({
        doc: { status: "ready", content, size: result.size },
        dirty: false,
        baselineContent: content,
      });
      return;
    }
    this.diskSize = result.size;
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

  private saveNow(): Promise<boolean> {
    if (this.savePromise) return this.savePromise;
    const pending = this.doSaveNow().finally(() => {
      if (this.savePromise === pending) this.savePromise = null;
    });
    this.savePromise = pending;
    return pending;
  }

  private async doSaveNow(): Promise<boolean> {
    const knownMtime = this.diskMtime;
    if (knownMtime !== null) {
      const stat = await invoke<FileStat>("fs_stat", {
        path: this.path,
        workspace: this.workspace,
      }).catch(() => null);
      if (stat && fileFingerprintChanged(knownMtime, this.diskSize, stat)) {
        const name = this.path.split(/[\\/]/).pop() ?? this.path;
        toast.warning(i18n.t("editor:saveConflict.title"), {
          id: `save-conflict:${this.key}`,
          description: i18n.t("editor:saveConflict.description", { name }),
          action: {
            label: i18n.t("editor:saveConflict.overwrite"),
            onClick: () => void this.writeToDisk(),
          },
        });
        return false;
      }
    }
    await this.writeToDisk();
    return true;
  }

  private async writeToDisk(): Promise<void> {
    const content = this.buffer;
    const diskContent = restoreEol(content, this.eol);
    const mtime = await invoke<number>("fs_write_file", {
      path: this.path,
      content: diskContent,
      workspace: this.workspace,
      source: "editor",
    });
    this.diskMtime = mtime;
    this.diskSize = new TextEncoder().encode(diskContent).byteLength;
    this.savedBuffer = content;
    this.publish({
      doc: this.snapshot.doc,
      dirty: this.buffer !== content,
      baselineContent: content,
    });
    notifyDocumentSaved(this.path);
    if (this.listeners.size === 0) this.scheduleDisposal();
  }

  private startRemotePolling(): void {
    if (this.workspace.kind !== "ssh" || this.remotePollTimer) return;
    let inFlight = false;
    this.remotePollTimer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void this.pollRemote().finally(() => {
        inFlight = false;
      });
    }, REMOTE_POLL_MS);
  }

  private async pollRemote(): Promise<void> {
    if (this.snapshot.dirty) return;
    const stat = await invoke<FileStat>("fs_stat", {
      path: this.path,
      workspace: this.workspace,
    }).catch(() => null);
    if (!stat || this.snapshot.dirty) return;
    if (!fileFingerprintChanged(this.diskMtime, this.diskSize, stat)) return;
    this.reload();
  }

  private clearAutoSaveTimer(): void {
    if (!this.autoSaveTimer) return;
    clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = null;
  }

  private scheduleDisposal(): void {
    if (this.disposeTimer) return;
    if (!this.snapshot.dirty) this.clearAutoSaveTimer();
    if (this.remotePollTimer) {
      clearInterval(this.remotePollTimer);
      this.remotePollTimer = null;
    }
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

export function resetSharedDocumentModelsForTests(): void {
  for (const model of [...models.values()]) {
    model.disposeForTests();
  }
  models.clear();
}

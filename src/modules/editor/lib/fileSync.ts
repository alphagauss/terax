/** 文件同步只保存最近一次完整校验的原始字节检查点，所有环境共用同一协议。 */

import type { WorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";

export type FileReadResult =
  | {
      kind: "text";
      content: string;
      size: number;
      mtime: number;
      revision: string;
    }
  | { kind: "binary"; size: number; mtime: number }
  | { kind: "toolarge"; size: number; limit: number; mtime: number };

type Unchanged = {
  kind: "unchanged";
  size: number;
  mtime: number;
  revision: string;
};

type Checkpoint = {
  size: number;
  mtime: number;
  revision: string;
  blocks: string[];
};
type SyncResult =
  | {
      kind: "changed";
      checkpoint: Checkpoint;
      chunks: { offset: number; data: string }[];
    }
  | { kind: "unchanged"; checkpoint: Checkpoint }
  | { kind: "missing" }
  | Extract<FileReadResult, { kind: "toolarge" }>;

/** 检查点仅在完整组装、摘要与文本校验成功后替换；失败可从旧检查点重试。 */
export class FileSyncReader {
  private checkpoint: Checkpoint | null = null;
  private bytes: Uint8Array<ArrayBuffer> | null = null;
  private generation = 0;

  clear(): void {
    this.generation++;
    this.checkpoint = null;
    this.bytes = null;
  }

  async read(
    path: string,
    workspace: WorkspaceEnv,
    force: boolean,
    verify: boolean,
    contentRequired = false,
  ): Promise<FileReadResult | Unchanged | null> {
    const generation = ++this.generation;
    const previous = this.bytes;
    const checkpoint = this.checkpoint;
    const result = await invoke<SyncResult>("fs_sync_file", {
      path,
      workspace,
      force,
      verify,
      checkpoint,
    });
    if (generation !== this.generation)
      throw new Error("file synchronization superseded");
    if (result.kind === "missing") return null;
    if (result.kind === "toolarge") {
      this.clear();
      return result;
    }
    if (result.kind === "unchanged" && previous && checkpoint) {
      // 相同全文摘要只能更新元数据，不能采用并发改写期间可能不一致的分块摘要。
      const next = { ...checkpoint, mtime: result.checkpoint.mtime };
      this.checkpoint = next;
      // 显式重载可能正在退出冲突或恢复视图，需重新解释缓存正文，无须重新传输。
      if (contentRequired) return this.classify(previous, next);
      const { size, mtime, revision } = next;
      return { kind: "unchanged", size, mtime, revision };
    }
    if (result.kind !== "changed")
      throw new Error("file sync checkpoint is unavailable");
    const bytes = new Uint8Array(result.checkpoint.size);
    if (previous) bytes.set(previous.subarray(0, bytes.length));
    for (const chunk of result.chunks) {
      const data = Uint8Array.from(atob(chunk.data), (character) =>
        character.charCodeAt(0),
      );
      bytes.set(data, chunk.offset);
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const revision = Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (revision !== result.checkpoint.revision)
      throw new Error("file changed during synchronization");
    if (generation !== this.generation)
      throw new Error("file synchronization superseded");
    const read = this.classify(bytes, result.checkpoint);
    this.bytes = bytes;
    this.checkpoint = result.checkpoint;
    return read;
  }

  private classify(bytes: Uint8Array, checkpoint: Checkpoint): FileReadResult {
    const { size, mtime, revision } = checkpoint;
    if (!bytes.subarray(0, 8192).includes(0)) {
      try {
        return {
          kind: "text",
          content: new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(bytes),
          size,
          mtime,
          revision,
        };
      } catch {
        /* 非 UTF-8 内容继续使用现有二进制展示。 */
      }
    }
    return { kind: "binary", size, mtime };
  }
}

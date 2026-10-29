/** PTY 通信与关闭状态属于会话生命周期，不依赖终端渲染器。 */
import { invoke, Channel } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { CloseActivityTracker } from "./closeActivity";

const textEncoder = new TextEncoder();

export type PtyHandlers = {
  onData: (bytes: Uint8Array) => void;
  onExit?: (code: number) => void;
};

export type PtySession = {
  id: number;
  write: (data: string, commandSubmitted?: boolean) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  close: (reclaimed?: boolean) => Promise<void>;
  isKnownIdle: () => boolean;
  needsCloseConfirmation: () => Promise<boolean>;
};

export async function openPty(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwd?: string,
  blocks?: boolean,
  shell?: string,
): Promise<PtySession> {
  // Raw bytes — no base64/JSON round-trip; messages arrive as ArrayBuffer.
  const onData = new Channel<ArrayBuffer>();
  const onExit = new Channel<number>();
  const activity = new CloseActivityTracker();

  let released = false;
  let openedId: number | null = null;
  let exitReceived = false;
  let hasUnsubmittedInput = false;
  const noop = () => {};
  const releaseHandlers = () => {
    if (released) return;
    released = true;
    onData.onmessage = noop;
    onExit.onmessage = noop;
  };

  onData.onmessage = (buf) => {
    const bytes = new Uint8Array(buf);
    const previous = activity.current;
    activity.feed(bytes);
    if (
      previous?.running &&
      activity.current !== previous &&
      !activity.current?.running
    ) {
      hasUnsubmittedInput = false;
    }
    handlers.onData(bytes);
  };
  onExit.onmessage = (code) => {
    exitReceived = true;
    handlers.onExit?.(code);
    releaseHandlers();
    if (openedId !== null) {
      void invoke("pty_close", { id: openedId }).catch(() => {});
    }
  };

  const id = await invoke<number>("pty_open", {
    cols,
    rows,
    cwd: cwd ?? null,
    workspace: currentWorkspaceEnv(),
    blocks: blocks ?? false,
    shell: shell ?? null,
    onData,
    onExit,
  });
  openedId = id;
  if (exitReceived) {
    void invoke("pty_close", { id }).catch(() => {});
  }

  let closed = false;
  let pendingWrites = 0;
  const headers = { "x-pty-id": String(id) };

  const knownCloseState = (): boolean | null => {
    if (closed || exitReceived) return false;
    if (pendingWrites > 0 || activity.current?.running) return true;
    return activity.current?.backgroundPids?.length === 0 ? false : null;
  };

  return {
    id,
    isKnownIdle: () =>
      !closed &&
      !exitReceived &&
      !hasUnsubmittedInput &&
      knownCloseState() === false,
    needsCloseConfirmation: async () => {
      // 查询期间作业变化时重查一次；持续变化则保留确认，不无限等待。
      for (let attempt = 0; attempt < 2; attempt++) {
        const known = knownCloseState();
        if (known !== null) return known;
        const snapshot = activity.current;
        try {
          const busy = await invoke<boolean | null>("pty_has_running_tasks", {
            id,
            shellPid: snapshot?.shellPid ?? null,
            backgroundPids: snapshot?.backgroundPids ?? null,
          });
          if (activity.current === snapshot)
            return knownCloseState() ?? busy !== false;
        } catch (error) {
          console.error("[terax] terminal close check failed", id, error);
          return knownCloseState() ?? true;
        }
      }
      return knownCloseState() ?? true;
    },
    // Raw bytes + id header: no JSON round-trip on the per-keystroke path.
    write: async (data, commandSubmitted = false) => {
      if (closed || exitReceived) return;
      if (data) hasUnsubmittedInput = true;
      const snapshot = activity.current;
      pendingWrites++;
      try {
        await invoke("pty_write", textEncoder.encode(data), { headers });
        // 写入成功但 Shell 尚未回传时保持保护；失败不改变原状态。
        if (
          (commandSubmitted || data.endsWith("\r")) &&
          activity.current === snapshot
        )
          activity.submitted();
      } finally {
        pendingWrites--;
      }
    },
    resize: (c, r) => invoke("pty_resize", { id, cols: c, rows: r }),
    close: async (reclaimed = false) => {
      if (closed) return;
      closed = true;
      try {
        await invoke("pty_close", reclaimed ? { id, reclaimed: true } : { id });
      } finally {
        releaseHandlers();
      }
    },
  };
}

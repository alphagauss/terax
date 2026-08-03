/**
 * 本文件管理终端的 PTY 生命周期、渲染器池绑定和块模式状态。
 * SSH PTY 绑定 Remote Runtime epoch，连接代际变化时统一丢弃并重建会话。
 */

import { ensureMonoFontsLoaded } from "@/lib/fonts";
import i18n from "@/i18n";
import { useRemoteRuntimeStore } from "@/modules/remote";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import type { SearchAddon } from "@xterm/addon-search";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BlockDecorations,
  type BlockMatch,
  type VisibleBlocks,
} from "../block/lib/blockDecorations";
import type { BlockMode } from "../block/lib/modeMachine";
import { DormantRing } from "./dormantRing";
import {
  createShellIntegrationState,
  registerCwdHandler,
  registerOsc52ClipboardHandler,
  registerPromptTracker,
} from "./osc-handlers";
import { openPty, type PtySession } from "./pty-bridge";
import { isRecoverableRemoteExit, shouldReplaceRemotePty } from "./exit";
import "../block/block.css";
import { ensureAgentActivityListener, isAgentActivePty } from "./agentActivity";
import {
  acquireSlot,
  applyBackgroundActive,
  applyCursorBlink,
  applyFontFamily,
  applyFontSize,
  applyFontWeight,
  applyLetterSpacing,
  applyTheme as applyPoolTheme,
  applyScrollback,
  applyWebglPreference,
  configureRendererPool,
  discardRetainedSlot,
  disposeTerminalSlot,
  focusSlot,
  getLiveSlotForTerminal,
  getSlotForTerminal,
  isTerminalAltScreen,
  parkTerminalSlot,
  poolSize,
  poolSlotStats,
  refreshTerminalSlot,
  releaseSlot,
  setSlotFocused,
} from "./rendererPool";

type Callbacks = {
  onSearchReady?: (addon: SearchAddon | null) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
};

type Session = {
  pty: PtySession | null;
  ptyOpening: boolean;
  initialCwd: string | undefined;
  lastCwd: string | null;
  pendingExit: number | null;
  shellExited: boolean;
  callbacks: Callbacks;
  visibleNow: boolean;
  focusedNow: boolean;
  disposed: boolean;
  ready: Promise<void>;
  cols: number;
  rows: number;
  container: HTMLDivElement | null;
  snapshot: string | null;
  dormantRing: DormantRing;
  pendingInput: string;
  hasSlot: boolean;
  blocks: boolean;
  blockMode: BlockMode;
  blockListeners: Set<() => void>;
  blockDecorations: BlockDecorations | null;
  // 由块终端输入框注册，在 xterm 网格抢走焦点时将输入焦点拉回输入栏。
  inputFocus: (() => void) | null;
  // 每个终端独立保存未发送的输入，工作区单一输入栏在焦点变化时切换草稿。
  inputDraft: string;
  // Live "input has text" flag from the block shell-input (gates the watermark).
  inputActive: boolean;
  // 命令提交后立即隐藏水印，无需等待 shell 的 OSC 133 C 经 PTY 返回。
  everSubmitted: boolean;
  // True if the slot was in alt-screen mode (TUI like vim, htop, dofek)
  // at the most recent release. Read once on the next bind to trigger a
  // SIGWINCH-driven repaint instead of replaying dormant bytes.
  altScreenAtRelease: boolean;
  // OSC 133 C..D 或块运行模式表示前台进程占用终端，隐藏时仍必须保留实时网格。
  commandRunning: boolean;
  hiddenReleaseTimer: ReturnType<typeof setTimeout> | null;
  spawnFailed: boolean;
  spawnGeneration: number;
  remoteEpoch: number | null;
  remoteSuspended: boolean;
  remoteNotice: RemoteNotice | null;
};

type RemoteNotice = "closed" | "connecting" | "reconnecting" | "disconnected";

const sessions = new Map<number, Session>();

/** 返回当前 SSH Workspace 已连接的 Runtime epoch。 */
function currentRemoteEpoch(): number | null {
  const workspace = currentWorkspaceEnv();
  const runtime = useRemoteRuntimeStore.getState().snapshot;
  return workspace.kind === "ssh" &&
    runtime.phase === "connected" &&
    runtime.profileId === workspace.profileId
    ? runtime.epoch
    : null;
}

/** 返回当前进程的终端是否依赖尚未连接的 SSH Runtime。 */
function remoteRuntimeUnavailable(): boolean {
  return currentWorkspaceEnv().kind === "ssh" && currentRemoteEpoch() === null;
}

// 视口监听器按 terminalId 存在模块作用域，使子级 overlay 可在父级 effect 创建会话前订阅。
const blockViewportListeners = new Map<number, Set<() => void>>();

const readyTerminals = new Set<number>();
const readyWaiters = new Map<
  number,
  { resolve: () => void; timer: ReturnType<typeof setTimeout> }[]
>();

function markSessionReady(terminalId: number): void {
  if (readyTerminals.has(terminalId)) return;
  readyTerminals.add(terminalId);
  const waiters = readyWaiters.get(terminalId);
  if (!waiters) return;
  readyWaiters.delete(terminalId);
  for (const w of waiters) {
    clearTimeout(w.timer);
    w.resolve();
  }
}

export function whenSessionReady(
  terminalId: number,
  timeoutMs = 4000,
): Promise<void> {
  if (readyTerminals.has(terminalId)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const arr = readyWaiters.get(terminalId);
      const i = arr?.findIndex((w) => w.timer === timer) ?? -1;
      if (arr && i >= 0) arr.splice(i, 1);
      resolve();
    }, timeoutMs);
    const arr = readyWaiters.get(terminalId) ?? [];
    arr.push({ resolve, timer });
    readyWaiters.set(terminalId, arr);
  });
}

const PENDING_INPUT_MAX = 256 * 1024;

// Input typed before the pty attaches is queued and flushed on attach. Cap the
// queue so a large paste into a still-spawning pane can't grow it without bound.
function queuePendingInput(s: Session, data: string): void {
  if (s.pendingInput.length + data.length > PENDING_INPUT_MAX) return;
  s.pendingInput += data;
}

export function writeToSession(terminalId: number, data: string): boolean {
  const s = sessions.get(terminalId);
  if (!s || s.shellExited) return false;
  if (s.pty) {
    void s.pty.write(data);
    return true;
  }
  queuePendingInput(s, data);
  return true;
}

export function submitToTerminal(terminalId: number, text: string): void {
  const s = sessions.get(terminalId);
  if (!s || s.shellExited) return;
  s.everSubmitted = true;
  // Bracketed paste keeps a multiline command atomic; trailing CR runs it.
  const data = text.includes("\n")
    ? `\x1b[200~${text}\x1b[201~\r`
    : `${text}\r`;
  if (s.pty) void s.pty.write(data);
  else queuePendingInput(s, data);
}

export function interruptTerminal(terminalId: number): void {
  sessions.get(terminalId)?.pty?.write("\x03");
}

export function terminalCwd(terminalId: number): string | null {
  return sessions.get(terminalId)?.lastCwd ?? null;
}

export function navigateFocusedBlocks(dir: -1 | 1): boolean {
  for (const [, s] of sessions) {
    if (!s.visibleNow || !s.focusedNow || !s.blockDecorations) continue;
    s.blockDecorations.navigateBlocks(dir);
    return true;
  }
  return false;
}

export function clearTerminalBlockSelection(terminalId: number): boolean {
  return (
    sessions.get(terminalId)?.blockDecorations?.clearBlockSelection() ?? false
  );
}

export function terminalGridSelection(terminalId: number): string | null {
  const sel = getSlotForTerminal(terminalId)?.term.getSelection() ?? "";
  return sel.length > 0 ? sel : null;
}

export function getTerminalBlockMode(terminalId: number): BlockMode {
  return sessions.get(terminalId)?.blockMode ?? "prompt";
}

export function subscribeTerminalBlockMode(
  terminalId: number,
  cb: () => void,
): () => void {
  const s = sessions.get(terminalId);
  if (!s) return () => {};
  s.blockListeners.add(cb);
  return () => {
    s.blockListeners.delete(cb);
  };
}

export function setTerminalInputFocus(
  terminalId: number,
  fn: (() => void) | null,
): void {
  const s = sessions.get(terminalId);
  if (s) s.inputFocus = fn;
}

export function focusTerminalInput(terminalId: number): void {
  sessions.get(terminalId)?.inputFocus?.();
}

export function getTerminalDraft(terminalId: number): string {
  return sessions.get(terminalId)?.inputDraft ?? "";
}

export function setTerminalDraft(terminalId: number, text: string): void {
  const s = sessions.get(terminalId);
  if (s) s.inputDraft = text;
}

export function setTerminalInputActivity(
  terminalId: number,
  active: boolean,
): void {
  const s = sessions.get(terminalId);
  if (!s || s.inputActive === active) return;
  s.inputActive = active;
  const set = blockViewportListeners.get(terminalId);
  if (set) for (const l of set) l();
}

export type WatermarkState = "visible" | "hidden" | "dead";

// Watermark gate: a block terminal that has never run a command, whose grid is
// still untouched, and whose input is empty. Synchronous so tab switches, slot
// rebinds and the Enter-to-OSC-133 gap never flash it over real content.
// "dead" is permanent and lets the component unmount for good. The grid check
// scans glyphs, not the cursor: the prompt integration prints a blank gap line
// at spawn, so the cursor sits below row 0 even on a visually empty terminal.
export function blockWatermarkState(terminalId: number): WatermarkState {
  const s = sessions.get(terminalId);
  if (!s || s.disposed) return "dead";
  if (s.everSubmitted || s.blockDecorations?.hasAnyBlock()) return "dead";
  if (!s.blockDecorations || s.inputActive) return "hidden";
  const slot = getSlotForTerminal(terminalId);
  if (!slot) return "hidden";
  const buf = slot.term.buffer.active;
  if (buf.baseY > 0) return "dead";
  const rows = Math.min(buf.length, slot.term.rows);
  for (let i = 0; i < rows; i++) {
    if (buf.getLine(i)?.translateToString(true)) return "dead";
  }
  return "visible";
}

/**
 * Clear the scrollback and screen of the currently focused terminal, keeping
 * the active prompt line. Matches macOS Terminal's ⌘K behaviour. Returns false when no
 * focused terminal slot is bound (e.g. focus is in the editor or AI panel).
 */
export function clearFocusedTerminal(): boolean {
  for (const [terminalId, s] of sessions) {
    if (!s.visibleNow || !s.focusedNow) continue;
    const slot = getSlotForTerminal(terminalId);
    if (!slot) continue;
    slot.term.clear();
    return true;
  }
  return false;
}

/** 根据原生 PTY ID 查找拥有它的前端终端 ID。 */
export function terminalIdForPty(ptyId: number): number | null {
  for (const [terminalId, s] of sessions) {
    if (s.pty?.id === ptyId) return terminalId;
  }
  return null;
}

function terminalBusy(s: Session): boolean {
  return s.commandRunning || (s.pty !== null && isAgentActivePty(s.pty.id));
}

const HIDDEN_RELEASE_DELAY_MS = 300;

// 隐藏终端进入空闲后，先让命令提示符写入实时缓冲区，再把 slot 交还给池。
function scheduleHiddenRelease(terminalId: number, s: Session): void {
  if (s.visibleNow || !s.hasSlot) return;
  cancelHiddenRelease(s);
  s.hiddenReleaseTimer = setTimeout(() => {
    s.hiddenReleaseTimer = null;
    if (s.disposed || s.visibleNow || !s.hasSlot) return;
    if (s.blocks || isTerminalAltScreen(terminalId) || terminalBusy(s)) return;
    unbindTerminalFromSlot(terminalId, s);
  }, HIDDEN_RELEASE_DELAY_MS);
}

function cancelHiddenRelease(s: Session): void {
  if (s.hiddenReleaseTimer !== null) {
    clearTimeout(s.hiddenReleaseTimer);
    s.hiddenReleaseTimer = null;
  }
}

async function releaseIfIdle(terminalId: number, s: Session): Promise<void> {
  const busy = await terminalHasForegroundJob(terminalId);
  if (busy || s.disposed || s.visibleNow || !s.hasSlot) return;
  if (s.blocks || isTerminalAltScreen(terminalId) || terminalBusy(s)) return;
  unbindTerminalFromSlot(terminalId, s);
}

async function terminalHasForegroundJob(terminalId: number): Promise<boolean> {
  const s = sessions.get(terminalId);
  if (!s?.pty || s.shellExited) return false;
  try {
    return await invoke<boolean>("pty_has_foreground_job", { id: s.pty.id });
  } catch (e) {
    console.error(
      "[terax] pty_has_foreground_job failed for terminal",
      terminalId,
      e,
    );
    return false;
  }
}

function onTerminalCommandState(terminalId: number, running: boolean): void {
  const s = sessions.get(terminalId);
  if (!s || s.commandRunning === running) return;
  s.commandRunning = running;
  if (!running) {
    scheduleHiddenRelease(terminalId, s);
    return;
  }
  cancelHiddenRelease(s);
  // 隐藏且已释放的终端启动命令时重新绑定保留的 slot，使输出实时解析而不是填充 ring。
  // 回调发生在 xterm 解析循环内，而重新绑定会触碰同一终端，因此延后执行。
  if (!s.visibleNow && !s.hasSlot && s.container && !s.disposed) {
    setTimeout(() => {
      if (s.disposed || s.visibleNow || s.hasSlot || !s.container) return;
      if (!terminalBusy(s)) return;
      bindTerminalToSlot(terminalId, s);
      parkTerminalSlot(terminalId);
    }, 0);
  }
}

ensureAgentActivityListener((ptyId) => {
  const terminalId = terminalIdForPty(ptyId);
  if (terminalId === null) return;
  const s = sessions.get(terminalId);
  if (s) scheduleHiddenRelease(terminalId, s);
});

configureRendererPool({
  resolveTerminal(terminalId) {
    const s = sessions.get(terminalId);
    if (!s) return null;
    return {
      writeToPty: (data) => {
        // Shell spawn failed (bad cwd, missing binary): Enter retries.
        if (s.spawnFailed) {
          if (data.includes("\r")) void respawnSession(terminalId);
          return;
        }
        if (s.pty) void s.pty.write(data);
        else queuePendingInput(s, data);
      },
      resizePty: (cols, rows) => {
        s.cols = cols;
        s.rows = rows;
        s.pty?.resize(cols, rows);
      },
      kickPty: (cols, rows) => {
        const pty = s.pty;
        if (!pty || cols <= 0 || rows <= 0) return;
        // Linux only emits SIGWINCH when the winsize ioctl actually
        // changes dims, so bump +1 row then restore. The TUI receives
        // (possibly two) SIGWINCHes and repaints from scratch.
        pty
          .resize(cols, rows + 1)
          .then(() => pty.resize(cols, rows))
          .catch((e) => console.warn("[terax] kickPty failed:", e));
      },
    };
  },
  evictTerminal(terminalId) {
    const s = sessions.get(terminalId);
    if (!s) return;
    unbindTerminalFromSlot(terminalId, s);
  },
  isTerminalFocused(terminalId) {
    const s = sessions.get(terminalId);
    return !!s && s.visibleNow && s.focusedNow;
  },
  isTerminalBlocks(terminalId) {
    return sessions.get(terminalId)?.blocks ?? false;
  },
  isTerminalBusy(terminalId) {
    const s = sessions.get(terminalId);
    return !!s && terminalBusy(s);
  },
  isTerminalVisible(terminalId) {
    return sessions.get(terminalId)?.visibleNow ?? false;
  },
  storeSnapshot(terminalId, out) {
    const s = sessions.get(terminalId);
    if (!s) return;
    s.snapshot = out.snapshot;
    if (out.cols > 0) s.cols = out.cols;
    if (out.rows > 0) s.rows = out.rows;
    s.altScreenAtRelease = out.altScreen;
  },
});

function ensureSession(
  terminalId: number,
  initialCwd?: string,
  blocks = false,
): Session {
  const existing = sessions.get(terminalId);
  if (existing) return existing;
  const remoteEpoch = currentRemoteEpoch();
  const remoteSuspended = remoteRuntimeUnavailable();

  const session: Session = {
    pty: null,
    ptyOpening: false,
    initialCwd,
    lastCwd: null,
    pendingExit: null,
    shellExited: remoteSuspended,
    callbacks: {},
    visibleNow: false,
    focusedNow: false,
    disposed: false,
    ready: Promise.resolve(),
    cols: 0,
    rows: 0,
    container: null,
    snapshot: null,
    dormantRing: new DormantRing(),
    pendingInput: "",
    hasSlot: false,
    blocks,
    blockMode: "prompt",
    blockListeners: new Set(),
    blockDecorations: null,
    inputFocus: null,
    inputDraft: "",
    inputActive: false,
    everSubmitted: false,
    altScreenAtRelease: false,
    commandRunning: false,
    hiddenReleaseTimer: null,
    spawnFailed: false,
    spawnGeneration: 0,
    remoteEpoch,
    remoteSuspended,
    remoteNotice: null,
  };
  sessions.set(terminalId, session);

  session.ready = (async () => {
    await ensureMonoFontsLoaded();
    await document.fonts.ready;
  })();

  return session;
}

function deliverPtyBytes(terminalId: number, bytes: Uint8Array): void {
  const s = sessions.get(terminalId);
  if (!s) return;
  // 保留的 slot 会继续实时解析，ring 只接收 slot 被占用或从未绑定的终端输出。
  const slot = getLiveSlotForTerminal(terminalId);
  if (slot) slot.term.write(bytes);
  else s.dormantRing.push(bytes);
}

const SPAWN_RETRY_DELAY_MS = 250;

async function openPtyWithRetry(
  terminalId: number,
  s: Session,
  cwd: string | undefined,
  generation: number,
): Promise<PtySession> {
  try {
    return await openPtyForSession(terminalId, s, cwd, generation);
  } catch (e) {
    console.error("[terax] openPty failed, retrying once:", e);
    await new Promise((r) => setTimeout(r, SPAWN_RETRY_DELAY_MS));
    if (s.disposed || s.spawnGeneration !== generation) throw e;
    return openPtyForSession(terminalId, s, cwd, generation);
  }
}

// 启动失败不能进入 onExit，否则会关闭面板，最后一个面板还可能循环重启。
// 错误直接显示在终端内，并允许用户按 Enter 重试。
function surfaceSpawnFailure(terminalId: number, s: Session, e: unknown): void {
  console.error("[terax] shell spawn failed:", e);
  s.shellExited = true;
  s.spawnFailed = true;
  const detail = String(e)
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 300);
  deliverPtyBytes(
    terminalId,
    new TextEncoder().encode(
      `\r\n\x1b[31m[terax] ${i18n.t("terminal:runtime.shellStartFailed", { detail })}\x1b[0m\r\n\x1b[2m${i18n.t("terminal:runtime.pressEnterToRetry")}\x1b[0m\r\n`,
    ),
  );
}

/** 在终端中追加 SSH Runtime 状态，重复状态不反复刷屏。 */
function showRemoteNotice(
  terminalId: number,
  s: Session,
  notice: RemoteNotice,
): void {
  const previous = s.remoteNotice;
  if (previous === notice) return;
  s.remoteNotice = notice;
  const slot = getSlotForTerminal(terminalId);
  if (slot) slot.term.options.disableStdin = true;
  const title =
    previous === null || notice === "connecting"
      ? `\r\n\x1b[31m[terax] ${i18n.t(
          notice === "connecting"
            ? "common:remoteWorkspace.connecting"
            : "common:remoteWorkspace.connectionClosed",
        )}\x1b[0m`
      : "";
  const detail =
    notice === "closed" || notice === "connecting"
      ? ""
      : `${title ? "\r\n" : ""}\x1b[2m${i18n.t(
          notice === "reconnecting"
            ? "common:remoteWorkspace.reconnecting"
            : "common:remoteWorkspace.manualReconnect",
        )}\x1b[0m`;
  deliverPtyBytes(
    terminalId,
    new TextEncoder().encode(`${title}${detail}\r\n`),
  );
  scheduleHiddenRelease(terminalId, s);
}

/** 立即冻结失效 epoch 的 PTY，并等待统一 Runtime 发布下一代连接。 */
function suspendRemoteSession(
  terminalId: number,
  s: Session,
  notice: RemoteNotice,
): void {
  if (!s.remoteSuspended) {
    s.spawnGeneration += 1;
    void s.pty?.close();
    s.pty = null;
    s.ptyOpening = false;
    s.shellExited = true;
    s.pendingExit = null;
    s.pendingInput = "";
    s.commandRunning = false;
    s.spawnFailed = false;
    s.remoteEpoch = null;
    s.remoteSuspended = true;
  }
  showRemoteNotice(terminalId, s, notice);
}

async function openPtyForSession(
  terminalId: number,
  s: Session,
  cwd: string | undefined,
  generation: number,
): Promise<PtySession> {
  const startCols = s.cols > 0 ? s.cols : 80;
  const startRows = s.rows > 0 ? s.rows : 24;
  const pty = await openPty(
    startCols,
    startRows,
    {
      onData: (bytes) => {
        if (s.spawnGeneration === generation)
          deliverPtyBytes(terminalId, bytes);
      },
      onExit: (code) => {
        if (s.spawnGeneration !== generation) return;
        s.shellExited = true;
        s.pty = null;
        s.pendingInput = "";
        s.commandRunning = false;
        if (isRecoverableRemoteExit(code)) {
          s.spawnFailed = false;
          suspendRemoteSession(terminalId, s, "closed");
          return;
        }
        const slot = getSlotForTerminal(terminalId);
        if (slot) slot.term.options.disableStdin = true;
        scheduleHiddenRelease(terminalId, s);
        if (s.callbacks.onExit) s.callbacks.onExit(code);
        else s.pendingExit = code;
      },
    },
    cwd,
    s.blocks,
    usePreferencesStore.getState().terminalShell || undefined,
  );
  // Only resize if the bound dims changed during the spawn: a same-size
  // ResizePseudoConsole during conhost warmup is a known ConPTY trigger for
  // a console that never renders (blank tab).
  if (
    s.cols > 0 &&
    s.rows > 0 &&
    (s.cols !== startCols || s.rows !== startRows)
  ) {
    void pty.resize(s.cols, s.rows);
  }
  return pty;
}

function applyBlockMode(terminalId: number, mode: BlockMode): void {
  const s = sessions.get(terminalId);
  if (!s) return;
  s.blockMode = mode;
  s.commandRunning = mode !== "prompt";
  const slot = getSlotForTerminal(terminalId);
  if (slot) {
    const prompt = mode === "prompt";
    slot.term.options.disableStdin = prompt;
    // Disable the helper textarea at the prompt so a grid click can't focus the
    // xterm (no flashing cursor) and can't steal focus from the shell input.
    if (slot.term.textarea) slot.term.textarea.disabled = prompt;
    if (!prompt) {
      slot.term.focus();
    } else if (s.visibleNow && s.focusedNow) {
      const inputFocus = s.inputFocus;
      if (inputFocus) setTimeout(inputFocus, 0);
    }
  }
  for (const l of s.blockListeners) l();
}

function bindTerminalToSlot(terminalId: number, s: Session): void {
  if (!s.container) return;
  const altScreen = s.altScreenAtRelease;
  s.altScreenAtRelease = false;
  acquireSlot({
    terminalId,
    container: s.container,
    snapshot: s.snapshot,
    altScreen,
    drainRing: (write) => s.dormantRing.drain(write),
    // Keep stdin alive after a spawn failure so Enter can trigger the retry.
    shellExited: s.shellExited && !s.spawnFailed,
    cols: s.cols,
    rows: s.rows,
    registerOsc: (term) => {
      if (s.blocks) {
        const osc52 = registerOsc52ClipboardHandler(term);
        const deco = new BlockDecorations(term, {
          onCwd: (next) => {
            markSessionReady(terminalId);
            if (s.lastCwd === next) return;
            s.lastCwd = next;
            s.callbacks.onCwd?.(next);
          },
          onMode: (mode) => applyBlockMode(terminalId, mode),
          onViewport: () => {
            const set = blockViewportListeners.get(terminalId);
            if (set) for (const l of set) l();
          },
        });
        s.blockDecorations = deco;
        const onGridFocus = () => {
          if (s.blockMode === "prompt") s.inputFocus?.();
        };
        term.textarea?.addEventListener("focus", onGridFocus);
        return [
          () => {
            s.blockDecorations = null;
            osc52();
            deco.dispose();
            term.textarea?.removeEventListener("focus", onGridFocus);
          },
        ];
      }
      // Shared in-command flag; see osc-handlers.ts. The prompt tracker
      // flips it on OSC 133 B/C/D/A; the cwd handler reads it to ignore OSC
      // 7 emitted by untrusted command output (remote SSH, `cat` of an
      // attacker file, etc.).
      const shellState = createShellIntegrationState();
      const prompt = registerPromptTracker(term, shellState, (running) =>
        onTerminalCommandState(terminalId, running),
      );
      const cwd = registerCwdHandler(
        term,
        (next) => {
          markSessionReady(terminalId);
          if (s.lastCwd === next) return;
          s.lastCwd = next;
          s.callbacks.onCwd?.(next);
        },
        shellState,
      );
      const osc52 = registerOsc52ClipboardHandler(term);
      return [prompt.dispose, cwd, osc52];
    },
    onSearchReady: (addon) => s.callbacks.onSearchReady?.(addon),
  });
  s.snapshot = null;
  s.hasSlot = true;
  if (s.blocks) applyBlockMode(terminalId, s.blockMode);
  if (s.lastCwd !== null) s.callbacks.onCwd?.(s.lastCwd);
  if (s.pendingExit !== null) {
    const code = s.pendingExit;
    s.pendingExit = null;
    s.callbacks.onExit?.(code);
  }
}

function unbindTerminalFromSlot(terminalId: number, s: Session): void {
  if (!s.hasSlot) return;
  s.callbacks.onSearchReady?.(null);
  const out = releaseSlot(terminalId);
  if (out) {
    if (out.cols > 0) s.cols = out.cols;
    if (out.rows > 0) s.rows = out.rows;
  }
  s.hasSlot = false;
}

function attachSession(
  terminalId: number,
  container: HTMLDivElement,
  callbacks: Callbacks,
): void {
  const s = sessions.get(terminalId);
  if (!s || s.disposed) return;
  s.callbacks = callbacks;
  s.container = container;

  if (s.visibleNow) bindTerminalToSlot(terminalId, s);

  if (!s.pty && !s.ptyOpening && !s.shellExited) {
    s.ptyOpening = true;
    const generation = ++s.spawnGeneration;
    openPtyWithRetry(terminalId, s, s.initialCwd, generation)
      .then((pty) => {
        if (s.spawnGeneration !== generation) {
          void pty.close();
          return;
        }
        s.ptyOpening = false;
        if (s.disposed || s.shellExited) {
          void pty.close();
          return;
        }
        s.pty = pty;
        if (s.pendingInput) {
          void pty.write(s.pendingInput);
          s.pendingInput = "";
        }
        if (s.cols > 0 && s.rows > 0) pty.resize(s.cols, s.rows);
      })
      .catch((e) => {
        if (s.spawnGeneration !== generation) return;
        s.ptyOpening = false;
        if (!s.disposed) surfaceSpawnFailure(terminalId, s, e);
      });
  }
}

function detachSession(terminalId: number): void {
  const s = sessions.get(terminalId);
  if (!s) return;
  unbindTerminalFromSlot(terminalId, s);
  s.callbacks = {};
  s.container = null;
}

/** 丢弃当前 PTY，并以新的生成代际重新创建该终端会话。 */
export async function respawnSession(
  terminalId: number,
  cwd?: string,
): Promise<void> {
  const s = sessions.get(terminalId);
  if (!s || s.disposed) return;
  const generation = ++s.spawnGeneration;
  void s.pty?.close();
  s.pty = null;
  s.snapshot = null;
  s.dormantRing = new DormantRing();
  s.shellExited = false;
  s.pendingExit = null;
  s.pendingInput = "";
  s.altScreenAtRelease = false;
  s.commandRunning = false;
  s.spawnFailed = false;
  s.remoteEpoch = currentRemoteEpoch();
  s.remoteSuspended = false;
  s.remoteNotice = null;
  cancelHiddenRelease(s);

  const slot = getSlotForTerminal(terminalId);
  if (slot) {
    slot.term.options.disableStdin = false;
    slot.term.clear();
    slot.term.reset();
  } else {
    discardRetainedSlot(terminalId);
  }

  s.ptyOpening = true;
  let pty: PtySession;
  try {
    pty = await openPtyWithRetry(
      terminalId,
      s,
      cwd ?? s.initialCwd,
      generation,
    );
  } catch (e) {
    if (s.spawnGeneration !== generation) return;
    s.ptyOpening = false;
    if (!s.disposed) surfaceSpawnFailure(terminalId, s, e);
    return;
  }
  if (s.disposed || s.spawnGeneration !== generation) {
    void pty.close();
    return;
  }
  s.ptyOpening = false;
  s.pty = pty;
  if (s.pendingInput) {
    void pty.write(s.pendingInput);
    s.pendingInput = "";
  }
  if (s.cols > 0 && s.rows > 0) pty.resize(s.cols, s.rows);
}

/** 查询终端是否仍有前台任务，查询失败时按无前台任务处理。 */
export async function terminalHasForegroundProcess(
  terminalId: number,
): Promise<boolean> {
  const s = sessions.get(terminalId);
  if (!s?.pty || s.shellExited) return false;
  try {
    const result = await invoke<boolean>("pty_has_foreground_process", {
      id: s.pty.id,
    });
    return result;
  } catch (e) {
    console.error(
      "[terax] pty_has_foreground_process failed for terminal",
      terminalId,
      e,
    );
    return false;
  }
}

export function disposeSession(terminalId: number): void {
  const s = sessions.get(terminalId);
  if (!s) return;
  s.disposed = true;
  s.spawnGeneration += 1;
  s.callbacks = {};
  cancelHiddenRelease(s);
  disposeTerminalSlot(terminalId);
  s.hasSlot = false;
  s.snapshot = null;
  s.pty?.close();
  s.pty = null;
  s.pendingInput = "";
  sessions.delete(terminalId);
  blockViewportListeners.delete(terminalId);
  readyTerminals.delete(terminalId);
  const waiters = readyWaiters.get(terminalId);
  if (waiters) {
    readyWaiters.delete(terminalId);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }
}

type Options = {
  terminalId: number;
  container: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  focused?: boolean;
  initialCwd?: string;
  blocks?: boolean;
  onSearchReady?: (addon: SearchAddon | null) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
};

/**
 * 将终端绑定到 renderer pool，并按 SSH Runtime epoch 管理 PTY 生命周期。
 */
export function useTerminalSession({
  terminalId,
  container,
  visible,
  focused = true,
  initialCwd,
  blocks = false,
  onSearchReady,
  onExit,
  onCwd,
}: Options) {
  const remoteBinding = useRemoteRuntimeStore((state) => {
    const workspace = currentWorkspaceEnv();
    const runtime = state.snapshot;
    if (workspace.kind !== "ssh") return "local" as const;
    if (runtime.phase === "idle" || runtime.profileId !== workspace.profileId) {
      return "disconnected" as const;
    }
    return runtime.phase === "connected" ? runtime.epoch : runtime.phase;
  });
  const cbRef = useRef({ onSearchReady, onExit, onCwd });
  cbRef.current = { onSearchReady, onExit, onCwd };

  // initialCwd 仅用于首次创建 PTY，不能作为 effect 依赖。OSC 7 会在每次 cd 后更新
  // cwd，若重新运行绑定 effect，就会反复解绑 renderer slot 并丢失块标记。
  const initialCwdRef = useRef(initialCwd);
  initialCwdRef.current = initialCwd;

  useEffect(() => {
    let cancelled = false;
    const s = ensureSession(terminalId, initialCwdRef.current, blocks);
    s.ready.then(() => {
      if (cancelled || s.disposed) return;
      const node = container.current;
      if (!node) return;
      attachSession(terminalId, node, {
        onSearchReady: (a) => cbRef.current.onSearchReady?.(a),
        onExit: (c) => cbRef.current.onExit?.(c),
        onCwd: (c) => cbRef.current.onCwd?.(c),
      });
      if (s.visibleNow && s.focusedNow && !s.blocks) focusSlot(terminalId);
    });
    return () => {
      cancelled = true;
      detachSession(terminalId);
    };
  }, [terminalId, container, blocks]);

  useEffect(() => {
    if (remoteBinding === "local") return;
    const s = ensureSession(terminalId, initialCwdRef.current, blocks);
    if (typeof remoteBinding !== "number") {
      suspendRemoteSession(terminalId, s, remoteBinding);
      return;
    }
    if (!shouldReplaceRemotePty(s.remoteEpoch, remoteBinding)) return;
    void respawnSession(terminalId, s.lastCwd ?? initialCwdRef.current);
  }, [blocks, terminalId, remoteBinding]);

  const [blockMode, setBlockMode] = useState<BlockMode>("prompt");
  useEffect(() => {
    if (!blocks) return;
    const s = ensureSession(terminalId, initialCwdRef.current, blocks);
    setBlockMode(s.blockMode);
    const cb = () =>
      setBlockMode(sessions.get(terminalId)?.blockMode ?? "prompt");
    s.blockListeners.add(cb);
    return () => {
      s.blockListeners.delete(cb);
    };
  }, [terminalId, blocks]);

  const fontSize = usePreferencesStore((p) => p.terminalFontSize);
  const zoomLevel = usePreferencesStore((p) => p.zoomLevel);
  useEffect(() => {
    applyFontSize(Math.max(4, Math.round(fontSize * zoomLevel)));
  }, [fontSize, zoomLevel]);

  const fontFamily = usePreferencesStore((p) => p.terminalFontFamily);
  useEffect(() => {
    applyFontFamily(fontFamily);
  }, [fontFamily]);

  const fontWeight = usePreferencesStore((p) => p.terminalFontWeight);
  useEffect(() => {
    applyFontWeight(fontWeight);
  }, [fontWeight]);

  const letterSpacing = usePreferencesStore((p) => p.terminalLetterSpacing);
  useEffect(() => {
    applyLetterSpacing(letterSpacing);
  }, [letterSpacing]);

  const scrollback = usePreferencesStore((p) => p.terminalScrollback);
  useEffect(() => {
    applyScrollback(scrollback);
  }, [scrollback]);

  const webglPref = usePreferencesStore((p) => p.terminalWebglEnabled);
  useEffect(() => {
    applyWebglPreference(webglPref);
  }, [webglPref]);

  const cursorBlink = usePreferencesStore((p) => p.terminalCursorBlink);
  useEffect(() => {
    applyCursorBlink(cursorBlink);
  }, [cursorBlink]);

  const bgActive = usePreferencesStore(
    (p) => p.backgroundKind === "image" && !!p.backgroundImageId,
  );
  useEffect(() => {
    applyBackgroundActive(bgActive);
  }, [bgActive]);

  useEffect(() => {
    const s = sessions.get(terminalId);
    if (!s) return;
    s.visibleNow = visible;
    s.focusedNow = focused;
    if (visible) {
      cancelHiddenRelease(s);
      if (s.container && !s.hasSlot) bindTerminalToSlot(terminalId, s);
      else if (s.hasSlot) refreshTerminalSlot(terminalId);
      setSlotFocused(terminalId, focused);
      if (focused && !blocks) focusSlot(terminalId);
    } else if (s.hasSlot) {
      // Always park first (keeps the grid live, pauses rendering); release
      // only after confirming nothing owns the terminal. Sync signals (OSC
      // 133, agent detect) short-circuit; the async foreground-process check
      // covers shells without integration.
      parkTerminalSlot(terminalId);
      if (!s.blocks && !isTerminalAltScreen(terminalId) && !terminalBusy(s)) {
        void releaseIfIdle(terminalId, s);
      }
    }
  }, [terminalId, visible, focused, blocks]);

  const write = useCallback(
    (data: string) => {
      const s = sessions.get(terminalId);
      if (!s || s.shellExited) return;
      if (s.pty) void s.pty.write(data);
      else queuePendingInput(s, data);
    },
    [terminalId],
  );

  const focus = useCallback(() => focusSlot(terminalId), [terminalId]);

  const getBuffer = useCallback(
    (maxLines = 200): string | null => {
      const s = sessions.get(terminalId);
      if (!s) return null;
      const slot = getLiveSlotForTerminal(terminalId);
      if (slot) {
        const buf = slot.term.buffer.active;
        const total = buf.length;
        const lines: string[] = [];
        const start = Math.max(0, total - maxLines);
        for (let i = start; i < total; i++) {
          lines.push(buf.getLine(i)?.translateToString(true) ?? "");
        }
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        return lines.join("\n");
      }
      if (!s.snapshot) return "";
      const plain = stripAnsi(s.snapshot);
      const lines = plain.split(/\r?\n/);
      const tail = lines.slice(-maxLines);
      while (tail.length && tail[tail.length - 1] === "") tail.pop();
      return tail.join("\n");
    },
    [terminalId],
  );

  const getSelection = useCallback((): string | null => {
    const slot = getSlotForTerminal(terminalId);
    const sel = slot?.term.getSelection() ?? "";
    return sel.length > 0 ? sel : null;
  }, [terminalId]);

  const applyTheme = useCallback(() => {
    applyPoolTheme();
  }, []);

  const selectBlockAt = useCallback(
    (clientY: number) =>
      sessions.get(terminalId)?.blockDecorations?.selectBlockAt(clientY),
    [terminalId],
  );

  const readBlockId = useCallback(
    (id: string) =>
      sessions.get(terminalId)?.blockDecorations?.readById(id) ?? null,
    [terminalId],
  );

  const subscribeBlocks = useCallback(
    (cb: () => void) => {
      let set = blockViewportListeners.get(terminalId);
      if (!set) {
        set = new Set();
        blockViewportListeners.set(terminalId, set);
      }
      set.add(cb);
      return () => {
        const live = blockViewportListeners.get(terminalId);
        live?.delete(cb);
        if (live && live.size === 0) blockViewportListeners.delete(terminalId);
      };
    },
    [terminalId],
  );

  const visibleBlocks = useCallback(
    (): VisibleBlocks =>
      sessions.get(terminalId)?.blockDecorations?.visibleBlocks() ?? {
        blocks: [],
        sticky: null,
      },
    [terminalId],
  );

  const searchBlock = useCallback(
    (id: string, query: string) =>
      sessions.get(terminalId)?.blockDecorations?.searchBlock(id, query) ?? [],
    [terminalId],
  );

  const revealMatch = useCallback(
    (m: BlockMatch) =>
      sessions.get(terminalId)?.blockDecorations?.revealMatch(m),
    [terminalId],
  );

  const clearSearch = useCallback(
    () => sessions.get(terminalId)?.blockDecorations?.clearSearch(),
    [terminalId],
  );

  return useMemo(
    () => ({
      write,
      focus,
      getBuffer,
      getSelection,
      applyTheme,
      blockMode,
      selectBlockAt,
      readBlockId,
      subscribeBlocks,
      visibleBlocks,
      searchBlock,
      revealMatch,
      clearSearch,
    }),
    [
      write,
      focus,
      getBuffer,
      getSelection,
      applyTheme,
      blockMode,
      selectBlockAt,
      readBlockId,
      subscribeBlocks,
      visibleBlocks,
      searchBlock,
      revealMatch,
      clearSearch,
    ],
  );
}

const ANSI_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[78=>]|\x1bc|\x1b[NOP\]X^_]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function terminalDebugStats() {
  const liveSessions = [...sessions.entries()].map(([terminalId, s]) => ({
    terminalId,
    pty: !!s.pty,
    visible: s.visibleNow,
    focused: s.focusedNow,
    hasSlot: s.hasSlot,
    ringBytes: s.dormantRing.byteLength(),
    snapshotLen: s.snapshot?.length ?? 0,
    shellExited: s.shellExited,
  }));
  const ringTotal = liveSessions.reduce((n, s) => n + s.ringBytes, 0);
  const snapshotTotal = liveSessions.reduce((n, s) => n + s.snapshotLen, 0);
  const slots = poolSlotStats();
  return {
    poolSize: poolSize(),
    webglContexts: slots.filter((s) => s.webgl).length,
    idleSlots: slots.filter((s) => s.terminalId === null).length,
    slots,
    sessionCount: liveSessions.length,
    sessions: liveSessions,
    ringBytesTotal: ringTotal,
    snapshotCharsTotal: snapshotTotal,
    domCanvases: document.querySelectorAll("canvas").length,
    domScreens: document.querySelectorAll(".xterm-screen").length,
    domRows: document.querySelectorAll(".xterm-rows > div").length,
    jsHeapBytes:
      (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
        ?.usedJSHeapSize ?? null,
  };
}

if (import.meta.env?.DEV && typeof window !== "undefined") {
  (window as unknown as { __teraxTerm?: unknown }).__teraxTerm =
    terminalDebugStats;
}

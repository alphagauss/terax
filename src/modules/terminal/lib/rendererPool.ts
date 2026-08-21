/**
 * 本文件管理可复用的 xterm 渲染器池及其终端输入输出桥接。
 * 负责渲染器生命周期、剪贴板动作和 TUI 鼠标路由，不拥有 PTY 会话状态。
 */

import { resolveFontFamily } from "@/lib/fonts";
import { openExternalUrl } from "@/lib/external-link";
import { IS_MAC } from "@/lib/platform";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { TerminalCursorStyle } from "@/modules/settings/store";
import { buildTerminalTheme } from "@/styles/terminalTheme";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type FontWeight, Terminal } from "@xterm/xterm";
import { shouldCursorBlink } from "./cursorBlink";
import {
  terminalClipboardIntent,
  terminalReadlineSequence,
} from "./keymap";
import {
  shouldUseLocalTerminalMouse,
  terminalMouseOverrideHeld,
  terminalWheelDeltaRows,
} from "./mouseRouting";
import {
  readTerminalClipboard,
  writeTerminalClipboard,
} from "./terminalClipboard";
import { createTerminalLinkHandler } from "./terminalLinks";

export const POOL_MAX_SIZE = 5;
const FIT_DEBOUNCE_MS = 8;
const PTY_RESIZE_DEBOUNCE_MS = 256;
const SNAPSHOT_SCROLLBACK_CAP = 5_000;

export type SlotAdapter = {
  resolveTerminal(terminalId: number): TerminalBridge | null;
  evictTerminal(terminalId: number): void;
  isTerminalFocused(terminalId: number): boolean;
  isTerminalBlocks(terminalId: number): boolean;
  isTerminalBusy(terminalId: number): boolean;
  isTerminalVisible(terminalId: number): boolean;
  storeSnapshot(terminalId: number, out: SerializeOutput): void;
};

export type TerminalBridge = {
  writeToPty(data: string): void;
  resizePty(cols: number, rows: number): void;
  // Force a SIGWINCH on the underlying PTY at the given dims. Implemented
  // as a +1 row / restore bump because the Linux kernel suppresses winsize
  // ioctls that don't actually change the size. Used to make alt-screen
  // TUIs repaint from scratch after they were dormant.
  kickPty(cols: number, rows: number): void;
};

export type Slot = {
  readonly id: number;
  readonly term: Terminal;
  readonly fitAddon: FitAddon;
  readonly searchAddon: SearchAddon;
  readonly serializeAddon: SerializeAddon;
  readonly host: HTMLDivElement;
  webglAddon: WebglAddon | null;
  webglCanvases: HTMLCanvasElement[];
  currentTerminalId: number | null;
  // 释放后仍完整保留缓冲区的终端，仅在其他终端占用该 slot 时序列化。
  retainedTerminalId: number | null;
  parked: boolean;
  oscDisposers: (() => void)[];
  observer: ResizeObserver | null;
  fitTimer: ReturnType<typeof setTimeout> | null;
  ptyTimer: ReturnType<typeof setTimeout> | null;
  webglReapTimer: ReturnType<typeof setTimeout> | null;
  slotReapTimer: ReturnType<typeof setTimeout> | null;
  unhideRaf: number | null;
  lastCols: number;
  lastRows: number;
  lastW: number;
  lastH: number;
  lastUsedAt: number;
  wheelRemainder: number;
};

const slots: Slot[] = [];
let recyclerEl: HTMLDivElement | null = null;
let adapter: SlotAdapter | null = null;

let windowActive =
  typeof document === "undefined" || (!document.hidden && document.hasFocus());
let windowActivityBound = false;
let cursorBlinkEnabled = false;

function bindWindowActivityListeners(): void {
  if (windowActivityBound || typeof window === "undefined") return;
  windowActivityBound = true;
  const sync = () => setWindowActive(!document.hidden && document.hasFocus());
  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);
  document.addEventListener("visibilitychange", sync);
}

function setWindowActive(active: boolean): void {
  if (windowActive === active) return;
  windowActive = active;
  for (const slot of slots) {
    if (slot.currentTerminalId === null) continue;
    applyCursorBlinkOnSlot(
      slot,
      adapter?.isTerminalFocused(slot.currentTerminalId) ?? false,
    );
  }
}

/** 配置 renderer pool 与终端会话之间的运行时桥接。 */
export function configureRendererPool(a: SlotAdapter): void {
  adapter = a;
  bindWindowActivityListeners();
}

export function forEachSlot(fn: (slot: Slot) => void): void {
  for (const s of slots) fn(s);
}

export function poolSize(): number {
  return slots.length;
}

export type PoolSlotStat = {
  id: number;
  terminalId: number | null;
  retainedTerminalId: number | null;
  parked: boolean;
  cols: number;
  rows: number;
  bufferLines: number;
  webgl: boolean;
  canvases: number;
};

export function poolSlotStats(): PoolSlotStat[] {
  return slots.map((s) => ({
    id: s.id,
    terminalId: s.currentTerminalId,
    retainedTerminalId: s.retainedTerminalId,
    parked: s.parked,
    cols: s.term.cols,
    rows: s.term.rows,
    bufferLines: s.term.buffer.active.length,
    webgl: !!s.webglAddon,
    canvases: s.webglCanvases.length,
  }));
}

// Bracketed paste via xterm, so an app that enabled it (Claude Code) treats a
// dropped path as a real paste while a plain shell gets the literal text.
export function pasteIntoTerminal(terminalId: number, text: string): boolean {
  const slot = slots.find((s) => s.currentTerminalId === terminalId);
  if (!slot) return false;
  slot.term.paste(text);
  return true;
}

/**
 * 将指定终端的当前选区写入系统剪贴板。
 *
 * 调用方可要求复制后清除选区，使智能 Ctrl+C 和对应菜单动作保持一致。
 */
export function copyTerminalSelection(
  terminalId: number,
  clearSelection = false,
): boolean {
  const slot = slots.find((s) => s.currentTerminalId === terminalId);
  const selection = slot?.term.getSelection() ?? "";
  if (!slot || !selection) return false;
  void writeTerminalClipboard(selection);
  if (clearSelection) slot.term.clearSelection();
  return true;
}

/**
 * 从系统剪贴板粘贴到指定终端。
 *
 * 剪贴板读取完成后重新按 terminal ID 解析 slot，避免渲染器复用期间粘贴到其他终端。
 */
export function pasteClipboardIntoTerminal(terminalId: number): void {
  void readTerminalClipboard().then((text) => {
    if (text) pasteIntoTerminal(terminalId, text);
  });
}

/**
 * 判断指定终端的鼠标事件是否应使用 Terax 本地行为。
 */
export function shouldUseLocalMouseForTerminal(
  terminalId: number,
  event: Pick<MouseEvent, "altKey" | "shiftKey">,
): boolean {
  const mode =
    slots.find((s) => s.currentTerminalId === terminalId)?.term.modes
      .mouseTrackingMode ?? "none";
  return shouldUseLocalTerminalMouse(mode, event, IS_MAC);
}

function getRecycler(): HTMLDivElement {
  if (recyclerEl?.isConnected) return recyclerEl;
  const el = document.createElement("div");
  el.setAttribute("data-terax-recycler", "");
  el.style.cssText =
    "position:fixed;left:-99999px;top:-99999px;width:1024px;height:768px;overflow:hidden;pointer-events:none;contain:strict;";
  document.body.appendChild(el);
  recyclerEl = el;
  return el;
}

const MCR_BG_ACTIVE = 4.5;
const MCR_BG_INACTIVE = 1;

function bgActive(
  prefs: ReturnType<typeof usePreferencesStore.getState>,
): boolean {
  return prefs.backgroundKind === "image" && !!prefs.backgroundImageId;
}

function termOptions() {
  const prefs = usePreferencesStore.getState();
  return {
    fontFamily: resolveFontFamily(prefs.terminalFontFamily),
    fontWeight: prefs.terminalFontWeight as FontWeight,
    letterSpacing: prefs.terminalLetterSpacing,
    fontSize: Math.max(4, Math.round(prefs.terminalFontSize * prefs.zoomLevel)),
    theme: buildTerminalTheme(),
    cursorBlink: false,
    cursorStyle: prefs.terminalCursorStyle,
    cursorInactiveStyle: "outline" as const,
    scrollback: prefs.terminalScrollback,
    smoothScrollDuration: 120,
    macOptionClickForcesSelection: IS_MAC,
    allowProposedApi: true,
    minimumContrastRatio: bgActive(prefs) ? MCR_BG_ACTIVE : MCR_BG_INACTIVE,
  };
}

export function applyBackgroundActive(active: boolean): void {
  const value = active ? MCR_BG_ACTIVE : MCR_BG_INACTIVE;
  for (const slot of slots) {
    if (slot.term.options.minimumContrastRatio === value) continue;
    slot.term.options.minimumContrastRatio = value;
  }
}

function createSlot(): Slot {
  let focusTerminal = () => {};
  const term = new Terminal({
    ...termOptions(),
    linkHandler: createTerminalLinkHandler(() => focusTerminal()),
  });
  focusTerminal = () => term.focus();
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const serializeAddon = new SerializeAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(searchAddon);
  term.loadAddon(serializeAddon);
  term.loadAddon(
    new WebLinksAddon((_e, uri) => {
      void openExternalUrl(uri, () => term.focus());
    }),
  );

  const host = document.createElement("div");
  host.style.cssText = "width:100%;height:100%;";
  host.setAttribute("data-terax-slot", String(slots.length));
  getRecycler().appendChild(host);
  term.open(host);

  const slot: Slot = {
    id: slots.length,
    term,
    fitAddon,
    searchAddon,
    serializeAddon,
    host,
    webglAddon: null,
    webglCanvases: [],
    currentTerminalId: null,
    retainedTerminalId: null,
    parked: false,
    oscDisposers: [],
    observer: null,
    fitTimer: null,
    ptyTimer: null,
    webglReapTimer: null,
    slotReapTimer: null,
    unhideRaf: null,
    lastCols: term.cols,
    lastRows: term.rows,
    lastW: 0,
    lastH: 0,
    lastUsedAt: 0,
    wheelRemainder: 0,
  };

  term.attachCustomWheelEventHandler((event) => {
    const mode = term.modes.mouseTrackingMode;
    if (mode === "none" || !terminalMouseOverrideHeld(event, IS_MAC)) {
      slot.wheelRemainder = 0;
      return true;
    }

    // TUI 已接管滚轮时，旁路键必须显式滚动本地缓冲并阻止 VT 鼠标上报。
    const cellHeight =
      host.clientHeight > 0 && term.rows > 0
        ? host.clientHeight / term.rows
        : (term.options.fontSize ?? 14);
    slot.wheelRemainder += terminalWheelDeltaRows(
      event.deltaY,
      event.deltaMode,
      cellHeight,
      term.rows,
    );
    const lines = Math.trunc(slot.wheelRemainder);
    if (lines !== 0) {
      slot.wheelRemainder -= lines;
      term.scrollLines(lines);
    }
    event.preventDefault();
    return false;
  });

  term.attachCustomKeyEventHandler((event) => {
    // IME 合成期间浏览器正在组合多次按键，原始 keydown 包括确认候选词的 Enter
    // 都不能转发给 PTY。xterm 会通过 compositionend 接收最终文本。
    // Chromium 在 isComposing 尚未设置时会为 IME 按键报告 keyCode 229。
    if (event.isComposing || event.keyCode === 229) return false;

    const terminalId = slot.currentTerminalId;
    if (terminalId === null) return false;
    const bridge = adapter?.resolveTerminal(terminalId);
    if (!bridge) return true;
    const readlineSequence = terminalReadlineSequence(event, {
      isMac: IS_MAC,
      isAlternateScreen: isAltScreen(slot),
    });
    if (readlineSequence) {
      event.preventDefault();
      if (event.type === "keydown") bridge.writeToPty(readlineSequence);
      return false;
    }
    if (isShiftEnter(event)) {
      event.preventDefault();
      if (event.type === "keydown") bridge.writeToPty("\x1b\r");
      return false;
    }
    const clipboardIntent = terminalClipboardIntent(event, {
      isMac: IS_MAC,
      smartCopyPaste: usePreferencesStore.getState().terminalSmartCopyPaste,
      hasSelection: slot.term.hasSelection(),
    });
    if (clipboardIntent === "copy") {
      if (event.type === "keydown") {
        copyTerminalSelection(terminalId, !event.shiftKey);
      }
      event.preventDefault();
      return false;
    }
    if (clipboardIntent === "paste") {
      if (event.type === "keydown") {
        pasteClipboardIntoTerminal(terminalId);
      }
      event.preventDefault();
      return false;
    }
    return true;
  });

  term.onData((data) => {
    const terminalId = slot.currentTerminalId;
    if (terminalId === null) return;
    adapter?.resolveTerminal(terminalId)?.writeToPty(data);
  });

  slots.push(slot);
  return slot;
}

type PickResult = { slot: Slot; previousTerminalId: number | null };

function isAltScreen(s: Slot): boolean {
  try {
    return s.term.buffer.active.type === "alternate";
  } catch {
    return false;
  }
}

function evictionScore(s: Slot): number {
  const terminalId = s.currentTerminalId;
  const visible =
    terminalId !== null && (adapter?.isTerminalVisible(terminalId) ?? false);
  const busy =
    terminalId !== null && (adapter?.isTerminalBusy(terminalId) ?? false);
  const blocks =
    terminalId !== null && (adapter?.isTerminalBlocks(terminalId) ?? false);
  const focused =
    terminalId !== null && (adapter?.isTerminalFocused(terminalId) ?? false);
  return (
    (visible ? 1000 : 0) +
    (isAltScreen(s) ? 100 : 0) +
    (busy ? 80 : 0) +
    (blocks ? 50 : 0) +
    (focused ? 10 : 0) +
    s.lastUsedAt / 1e12
  );
}

export function visibleBindingsRequireAnotherSlot(
  bindings: Array<{ bound: boolean; visible: boolean }>,
): boolean {
  return (
    bindings.length > 0 &&
    bindings.every((binding) => binding.bound && binding.visible)
  );
}

function pickSlotFor(terminalId: number): PickResult {
  const retainedOwn = slots.find(
    (s) => s.currentTerminalId === null && s.retainedTerminalId === terminalId,
  );
  if (retainedOwn) return { slot: retainedOwn, previousTerminalId: null };

  const clean = slots.find(
    (s) => s.currentTerminalId === null && s.retainedTerminalId === null,
  );
  if (clean) return { slot: clean, previousTerminalId: null };
  if (slots.length < POOL_MAX_SIZE)
    return { slot: createSlot(), previousTerminalId: null };

  // Retained buffers are cheaper to lose than bound ones: serialize, no evict.
  let retained: Slot | null = null;
  for (const s of slots) {
    if (s.currentTerminalId !== null) continue;
    if (!retained || s.lastUsedAt < retained.lastUsedAt) retained = s;
  }
  if (retained) return { slot: retained, previousTerminalId: null };

  const allBoundSlotsVisible = visibleBindingsRequireAnotherSlot(
    slots.map((slot) => ({
      bound: slot.currentTerminalId !== null,
      visible:
        slot.currentTerminalId !== null &&
        (adapter?.isTerminalVisible(slot.currentTerminalId) ?? false),
    })),
  );
  if (allBoundSlotsVisible) {
    return { slot: createSlot(), previousTerminalId: null };
  }

  let best: Slot | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const s of slots) {
    if (s.currentTerminalId === terminalId)
      return { slot: s, previousTerminalId: null };
    const score = evictionScore(s);
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  if (!best) throw new Error("Renderer pool has no evictable slot");
  const chosen = best;
  return { slot: chosen, previousTerminalId: chosen.currentTerminalId };
}

export type AcquireParams = {
  terminalId: number;
  container: HTMLDivElement;
  snapshot: string | null;
  // True if the slot was in alt-screen mode (TUI like vim, htop, dofek)
  // at the time it was released. When set, bindSlot skips ring replay
  // and kicks SIGWINCH so the TUI repaints from scratch.
  altScreen: boolean;
  drainRing: (write: (bytes: Uint8Array) => void) => void;
  shellExited: boolean;
  cols: number;
  rows: number;
  registerOsc: (term: Terminal) => (() => void)[];
  onSearchReady: (addon: SearchAddon) => void;
};

/** 为终端获取或复用 renderer slot，并在必要时保存被替换终端的快照。 */
export function acquireSlot(params: AcquireParams): Slot {
  const existing = slots.find((s) => s.currentTerminalId === params.terminalId);
  if (existing) {
    rewireSlot(existing, params);
    return existing;
  }

  const pick = pickSlotFor(params.terminalId);
  if (pick.previousTerminalId !== null) {
    adapter?.evictTerminal(pick.previousTerminalId);
  }
  if (
    pick.slot.currentTerminalId !== null &&
    pick.slot.currentTerminalId !== params.terminalId
  ) {
    detachSlotFromTerminal(pick.slot, false);
  }
  if (
    pick.slot.retainedTerminalId !== null &&
    pick.slot.retainedTerminalId !== params.terminalId
  ) {
    adapter?.storeSnapshot(
      pick.slot.retainedTerminalId,
      serializeSlot(pick.slot),
    );
    discardRetention(pick.slot);
  }
  bindSlot(pick.slot, params);
  return pick.slot;
}

function discardRetention(slot: Slot): void {
  slot.retainedTerminalId = null;
  for (const d of slot.oscDisposers) {
    try {
      d();
    } catch {}
  }
  slot.oscDisposers = [];
}

function bindSlot(slot: Slot, p: AcquireParams): void {
  const fast = slot.retainedTerminalId === p.terminalId;
  const stale =
    !slot.webglAddon ||
    slot.parked ||
    performance.now() - slot.lastUsedAt > SLOT_STALE_MS;
  const hadWebgl = !!slot.webglAddon;
  slot.retainedTerminalId = null;
  slot.currentTerminalId = p.terminalId;
  slot.lastUsedAt = performance.now();

  cancelPendingUnhide(slot);
  cancelWebglReap(slot);
  cancelSlotReap(slot);
  unparkSlotHost(slot);
  if (!fast) {
    slot.host.style.visibility = "hidden";
    if (hadWebgl) disposeSlotWebgl(slot);
  }

  if (slot.host.parentNode !== p.container) {
    p.container.appendChild(slot.host);
  }

  slot.term.options.disableStdin = p.shellExited;

  if (!fast) {
    slot.term.clear();
    slot.term.reset();

    if (
      p.cols > 0 &&
      p.rows > 0 &&
      (slot.term.cols !== p.cols || slot.term.rows !== p.rows)
    ) {
      slot.term.resize(p.cols, p.rows);
    }

    if (p.snapshot) {
      try {
        slot.term.write(p.snapshot);
      } catch (e) {
        console.warn("[terax] snapshot replay failed:", e);
      }
    }
    if (p.altScreen) {
      // TUI output is incremental cursor-positioned updates that can't be
      // replayed on top of a stale snapshot; the SIGWINCH kick below makes
      // the TUI redraw from scratch instead.
      p.drainRing(() => {});
    } else {
      p.drainRing((bytes) => slot.term.write(bytes));
    }
    try {
      slot.term.write("\x1b[?25h");
    } catch {}

    for (const d of slot.oscDisposers) {
      try {
        d();
      } catch {}
    }
    slot.oscDisposers = p.registerOsc(slot.term);
  } else {
    p.drainRing((bytes) => slot.term.write(bytes));
  }

  setupResizeObserver(slot, p);
  slot.fitAddon.fit();
  slot.lastCols = slot.term.cols;
  slot.lastRows = slot.term.rows;
  slot.lastW = p.container.clientWidth;
  slot.lastH = p.container.clientHeight;
  if (slot.lastCols !== p.cols || slot.lastRows !== p.rows) {
    // resizePty updates session.cols/rows + pty backend; no separate scope call.
    adapter
      ?.resolveTerminal(p.terminalId)
      ?.resizePty(slot.lastCols, slot.lastRows);
  }

  applyCursorBlinkOnSlot(
    slot,
    adapter?.isTerminalFocused(p.terminalId) ?? false,
  );

  if (!fast && p.altScreen && !p.shellExited) {
    adapter
      ?.resolveTerminal(p.terminalId)
      ?.kickPty(slot.term.cols, slot.term.rows);
  }

  if (fast) {
    if (stale) {
      if (!slot.webglAddon) attachWebgl(slot);
      try {
        slot.term.refresh(0, slot.term.rows - 1);
      } catch {}
    }
    if (adapter?.isTerminalFocused(p.terminalId)) slot.term.focus();
  } else {
    scheduleUnhide(slot, stale || hadWebgl);
  }

  p.onSearchReady(slot.searchAddon);
}

function scheduleUnhide(slot: Slot, stale: boolean): void {
  slot.unhideRaf = requestAnimationFrame(() => {
    slot.unhideRaf = requestAnimationFrame(() => {
      slot.unhideRaf = null;
      slot.host.style.visibility = "";
      if (stale) {
        if (!slot.webglAddon) attachWebgl(slot);
        try {
          slot.term.refresh(0, slot.term.rows - 1);
        } catch {}
      }
      const terminalId = slot.currentTerminalId;
      if (terminalId !== null && adapter?.isTerminalFocused(terminalId)) {
        slot.term.focus();
      }
    });
  });
}

function cancelPendingUnhide(slot: Slot): void {
  if (slot.unhideRaf !== null) {
    cancelAnimationFrame(slot.unhideRaf);
    slot.unhideRaf = null;
  }
}

function rewireSlot(slot: Slot, p: AcquireParams): void {
  slot.lastUsedAt = performance.now();
  unparkSlotHost(slot);
  if (slot.host.parentNode !== p.container) {
    p.container.appendChild(slot.host);
  }
  setupResizeObserver(slot, p);
  slot.fitAddon.fit();
  slot.lastW = p.container.clientWidth;
  slot.lastH = p.container.clientHeight;
  if (slot.term.cols !== p.cols || slot.term.rows !== p.rows) {
    adapter
      ?.resolveTerminal(p.terminalId)
      ?.resizePty(slot.term.cols, slot.term.rows);
  }
  slot.lastCols = slot.term.cols;
  slot.lastRows = slot.term.rows;
  p.onSearchReady(slot.searchAddon);
}

function setupResizeObserver(slot: Slot, p: AcquireParams): void {
  slot.observer?.disconnect();
  if (slot.fitTimer) clearTimeout(slot.fitTimer);
  if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
  slot.fitTimer = null;
  slot.ptyTimer = null;

  const container = p.container;
  const flushPty = () => {
    slot.ptyTimer = null;
    if (slot.currentTerminalId !== p.terminalId) return;
    if (slot.term.cols === slot.lastCols && slot.term.rows === slot.lastRows)
      return;
    slot.lastCols = slot.term.cols;
    slot.lastRows = slot.term.rows;
    adapter
      ?.resolveTerminal(p.terminalId)
      ?.resizePty(slot.lastCols, slot.lastRows);
  };

  slot.observer = new ResizeObserver(() => {
    if (slot.parked) return;
    if (slot.fitTimer) clearTimeout(slot.fitTimer);
    slot.fitTimer = setTimeout(() => {
      slot.fitTimer = null;
      if (slot.currentTerminalId !== p.terminalId || slot.parked) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === slot.lastW && h === slot.lastH) return;
      slot.lastW = w;
      slot.lastH = h;
      slot.fitAddon.fit();
      if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
      slot.ptyTimer = setTimeout(flushPty, PTY_RESIZE_DEBOUNCE_MS);
    }, FIT_DEBOUNCE_MS);
  });
  slot.observer.observe(container);
}

export type SerializeOutput = {
  snapshot: string | null;
  cols: number;
  rows: number;
  altScreen: boolean;
};

export type ReleaseOutput = { cols: number; rows: number };

/** 释放终端当前绑定的 renderer slot，同时保留可快速恢复的缓冲区。 */
export function releaseSlot(terminalId: number): ReleaseOutput | null {
  const slot = slots.find((s) => s.currentTerminalId === terminalId);
  if (!slot) return null;
  detachSlotFromTerminal(slot, true);
  return { cols: slot.term.cols, rows: slot.term.rows };
}

function serializeSlot(slot: Slot): SerializeOutput {
  let snapshot: string | null = null;
  try {
    const cap = Math.min(
      SNAPSHOT_SCROLLBACK_CAP,
      usePreferencesStore.getState().terminalScrollback,
    );
    snapshot = slot.serializeAddon.serialize({ scrollback: cap });
  } catch (e) {
    console.warn("[terax] serialize failed:", e);
  }
  return {
    snapshot,
    cols: slot.term.cols,
    rows: slot.term.rows,
    altScreen: isAltScreen(slot),
  };
}

function detachSlotFromTerminal(slot: Slot, retain: boolean): void {
  if (retain && slot.currentTerminalId !== null) {
    slot.retainedTerminalId = slot.currentTerminalId;
    parkSlotHost(slot);
  } else {
    discardRetention(slot);
    unparkSlotHost(slot);
    if (slot.host.parentNode !== getRecycler()) {
      getRecycler().appendChild(slot.host);
    }
  }

  slot.observer?.disconnect();
  slot.observer = null;
  if (slot.fitTimer) clearTimeout(slot.fitTimer);
  if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
  slot.fitTimer = null;
  slot.ptyTimer = null;

  cancelPendingUnhide(slot);
  slot.host.style.visibility = "";

  slot.currentTerminalId = null;
  slot.lastUsedAt = performance.now();
  scheduleWebglReap(slot);
  scheduleSlotReap(slot);
}

// display:none makes xterm's IntersectionObserver pause rendering while the
// buffer keeps parsing writes; visibility:hidden would not (geometry remains).
function parkSlotHost(slot: Slot): void {
  if (slot.parked) return;
  slot.parked = true;
  slot.host.style.display = "none";
}

function unparkSlotHost(slot: Slot): void {
  if (!slot.parked) return;
  slot.parked = false;
  slot.host.style.display = "";
}

function scheduleWebglReap(slot: Slot): void {
  cancelWebglReap(slot);
  if (!slot.webglAddon) return;
  slot.webglReapTimer = setTimeout(() => {
    slot.webglReapTimer = null;
    if (slot.currentTerminalId === null || slot.parked) disposeSlotWebgl(slot);
  }, WEBGL_REAP_GRACE_MS);
}

function cancelWebglReap(slot: Slot): void {
  if (slot.webglReapTimer !== null) {
    clearTimeout(slot.webglReapTimer);
    slot.webglReapTimer = null;
  }
}

function scheduleSlotReap(slot: Slot): void {
  cancelSlotReap(slot);
  slot.slotReapTimer = setTimeout(() => {
    slot.slotReapTimer = null;
    reapIdleSlot(slot);
  }, SLOT_REAP_GRACE_MS);
}

function cancelSlotReap(slot: Slot): void {
  if (slot.slotReapTimer !== null) {
    clearTimeout(slot.slotReapTimer);
    slot.slotReapTimer = null;
  }
}

function reapIdleSlot(slot: Slot): void {
  if (slot.currentTerminalId !== null) return;
  const idle = slots.filter((s) => s.currentTerminalId === null);
  if (idle.length <= IDLE_SLOTS_KEEP_WARM) return;
  idle.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  const surplus = idle.slice(0, idle.length - IDLE_SLOTS_KEEP_WARM);
  if (!surplus.includes(slot)) return;
  if (slot.retainedTerminalId !== null) {
    adapter?.storeSnapshot(slot.retainedTerminalId, serializeSlot(slot));
  }
  disposeSlot(slot);
}

function disposeSlot(slot: Slot): void {
  cancelSlotReap(slot);
  cancelWebglReap(slot);
  cancelPendingUnhide(slot);
  if (slot.fitTimer) clearTimeout(slot.fitTimer);
  if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
  slot.fitTimer = null;
  slot.ptyTimer = null;
  slot.observer?.disconnect();
  slot.observer = null;
  for (const d of slot.oscDisposers) {
    try {
      d();
    } catch {}
  }
  slot.oscDisposers = [];
  disposeSlotWebgl(slot);
  try {
    slot.term.dispose();
  } catch (e) {
    console.warn("[terax] slot dispose failed:", e);
  }
  slot.host.remove();
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
}

const WEBGL_RECOVERY_DELAY_MS = 250;
// Below this a re-shown slot is fresh enough to trust; above it, repaint on
// unhide to defeat silent GPU/context staleness.
const SLOT_STALE_MS = 10_000;
const WEBGL_REAP_GRACE_MS = 30_000;
const SLOT_REAP_GRACE_MS = 45_000;
const IDLE_SLOTS_KEEP_WARM = 1;

function attachWebgl(slot: Slot): void {
  if (slot.webglAddon || !slot.term.element) return;
  if (!usePreferencesStore.getState().terminalWebglEnabled) return;
  const elem = slot.term.element;
  const before = new Set<HTMLCanvasElement>(
    elem.querySelectorAll<HTMLCanvasElement>("canvas"),
  );
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      const cur = slot.webglAddon;
      if (cur === webgl) {
        slot.webglAddon = null;
        slot.webglCanvases = [];
      }
      try {
        webgl.dispose();
      } catch {}
      // Recovery: WebKit may transiently lose contexts on sleep/wake or GPU
      // reset; without re-attach the slot would silently fall back to DOM
      // forever. Defer past WebKit's reset window before retrying.
      setTimeout(() => {
        if (slot.webglAddon || slot.currentTerminalId === null || slot.parked)
          return;
        if (!usePreferencesStore.getState().terminalWebglEnabled) return;
        attachWebgl(slot);
        if (slot.webglAddon) {
          try {
            slot.term.refresh(0, slot.term.rows - 1);
          } catch {}
        }
      }, WEBGL_RECOVERY_DELAY_MS);
    });
    slot.term.loadAddon(webgl);
    const after = elem.querySelectorAll<HTMLCanvasElement>("canvas");
    const added: HTMLCanvasElement[] = [];
    for (const c of after) if (!before.has(c)) added.push(c);
    slot.webglAddon = webgl;
    slot.webglCanvases = added;
  } catch (e) {
    console.warn("[terax-webgl] unavailable:", e);
  }
}

function disposeSlotWebgl(slot: Slot): void {
  if (!slot.webglAddon) return;
  const addon = slot.webglAddon;
  for (const canvas of slot.webglCanvases) releaseCanvasContext(canvas);
  slot.webglCanvases = [];
  try {
    addon.dispose();
  } catch (e) {
    console.warn("[terax-webgl] dispose failed:", e);
  }
  try {
    const r = (
      addon as unknown as { _renderer?: Record<string, unknown> | null }
    )._renderer;
    if (r) {
      r._canvas = null;
      r._gl = null;
      r._charAtlas = null;
      r._atlas = null;
    }
    (
      addon as unknown as { _renderer?: unknown; _renderService?: unknown }
    )._renderer = null;
    (
      addon as unknown as { _renderer?: unknown; _renderService?: unknown }
    )._renderService = null;
  } catch {}
  slot.webglAddon = null;
}

function releaseCanvasContext(canvas: HTMLCanvasElement): void {
  let gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
  } catch {}
  if (!gl) {
    try {
      gl = canvas.getContext("webgl") as WebGLRenderingContext | null;
    } catch {}
  }
  if (gl) {
    try {
      const ext = gl.getExtension("WEBGL_lose_context");
      if (ext && !gl.isContextLost()) ext.loseContext();
    } catch {}
  }
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {}
}

export function applyWebglPreference(enabled: boolean): void {
  for (const slot of slots) {
    if (enabled) {
      if (slot.currentTerminalId !== null && !slot.parked && !slot.webglAddon) {
        attachWebgl(slot);
        if (slot.webglAddon) {
          try {
            slot.term.refresh(0, slot.term.rows - 1);
          } catch {}
        }
      }
    } else if (slot.webglAddon) {
      cancelWebglReap(slot);
      disposeSlotWebgl(slot);
    }
  }
}

// Parked and retained slots can't be measured (display:none); poison lastW
// so the refit happens on unpark/rebind instead.
function refitSlot(slot: Slot): void {
  if (slot.parked || slot.currentTerminalId === null) {
    slot.lastW = -1;
    return;
  }
  slot.fitAddon.fit();
  slot.lastCols = slot.term.cols;
  slot.lastRows = slot.term.rows;
  adapter
    ?.resolveTerminal(slot.currentTerminalId)
    ?.resizePty(slot.term.cols, slot.term.rows);
}

export function applyFontSize(size: number): void {
  for (const slot of slots) {
    if (slot.term.options.fontSize === size) continue;
    slot.term.options.fontSize = size;
    refitSlot(slot);
  }
}

export function applyLetterSpacing(spacing: number): void {
  for (const slot of slots) {
    if (slot.term.options.letterSpacing === spacing) continue;
    slot.term.options.letterSpacing = spacing;
    refitSlot(slot);
  }
}

export function applyFontFamily(family: string): void {
  const resolved = resolveFontFamily(family);
  for (const slot of slots) {
    if (slot.term.options.fontFamily === resolved) continue;
    slot.term.options.fontFamily = resolved;
    refitSlot(slot);
  }
}

export function applyFontWeight(weight: string): void {
  for (const slot of slots) {
    if (slot.term.options.fontWeight === weight) continue;
    slot.term.options.fontWeight = weight as FontWeight;
  }
}

export function applyScrollback(value: number): void {
  for (const slot of slots) {
    if (slot.term.options.scrollback === value) continue;
    slot.term.options.scrollback = value;
  }
}

export function applyTheme(): void {
  const theme = buildTerminalTheme();
  for (const slot of slots) {
    slot.term.options.theme = theme;
  }
}

export function focusSlot(terminalId: number): void {
  const slot = slots.find((s) => s.currentTerminalId === terminalId);
  slot?.term.focus();
}

export function setSlotFocused(terminalId: number, focused: boolean): void {
  const slot = slots.find((s) => s.currentTerminalId === terminalId);
  if (!slot) return;
  applyCursorBlinkOnSlot(slot, focused);
}

export function applyCursorBlink(enabled: boolean): void {
  cursorBlinkEnabled = enabled;
  for (const slot of slots) {
    if (slot.currentTerminalId === null) continue;
    applyCursorBlinkOnSlot(
      slot,
      adapter?.isTerminalFocused(slot.currentTerminalId) ?? false,
    );
  }
}

/** 将光标样式同步到活动、停放和待复用的全部 renderer slot。 */
export function applyCursorStyle(style: TerminalCursorStyle): void {
  for (const slot of slots) {
    if (slot.term.options.cursorStyle === style) continue;
    slot.term.options.cursorStyle = style;
  }
}

function applyCursorBlinkOnSlot(slot: Slot, focused: boolean): void {
  const desired = shouldCursorBlink(cursorBlinkEnabled, windowActive, focused);
  if (slot.term.options.cursorBlink === desired) return;
  slot.term.options.cursorBlink = desired;
}

export function getSlotForTerminal(terminalId: number): Slot | null {
  return slots.find((s) => s.currentTerminalId === terminalId) ?? null;
}

export function isTerminalAltScreen(terminalId: number): boolean {
  const slot = slots.find((s) => s.currentTerminalId === terminalId);
  return slot ? isAltScreen(slot) : false;
}

export function parkTerminalSlot(terminalId: number): void {
  const slot = slots.find((s) => s.currentTerminalId === terminalId);
  if (!slot) return;
  parkSlotHost(slot);
  scheduleWebglReap(slot);
}

export function refreshTerminalSlot(terminalId: number): void {
  const slot = slots.find((s) => s.currentTerminalId === terminalId);
  if (!slot) return;
  cancelWebglReap(slot);
  unparkSlotHost(slot);
  if (usePreferencesStore.getState().terminalWebglEnabled && !slot.webglAddon) {
    attachWebgl(slot);
  }
  // The observer skips parked slots; catch up on container resizes here.
  const container = slot.host.parentElement;
  if (
    container &&
    (container.clientWidth !== slot.lastW ||
      container.clientHeight !== slot.lastH)
  ) {
    slot.lastW = container.clientWidth;
    slot.lastH = container.clientHeight;
    slot.fitAddon.fit();
    if (slot.term.cols !== slot.lastCols || slot.term.rows !== slot.lastRows) {
      slot.lastCols = slot.term.cols;
      slot.lastRows = slot.term.rows;
      adapter
        ?.resolveTerminal(terminalId)
        ?.resizePty(slot.lastCols, slot.lastRows);
    }
  }
  try {
    slot.term.refresh(0, slot.term.rows - 1);
  } catch {}
}

export function disposeTerminalSlot(terminalId: number): void {
  const slot = slots.find(
    (s) =>
      s.currentTerminalId === terminalId || s.retainedTerminalId === terminalId,
  );
  if (slot) disposeSlot(slot);
}

export function discardRetainedSlot(terminalId: number): void {
  const slot = slots.find(
    (s) => s.currentTerminalId === null && s.retainedTerminalId === terminalId,
  );
  if (!slot) return;
  discardRetention(slot);
  slot.term.clear();
  slot.term.reset();
}

export function getLiveSlotForTerminal(terminalId: number): Slot | null {
  return (
    slots.find(
      (s) =>
        s.currentTerminalId === terminalId ||
        s.retainedTerminalId === terminalId,
    ) ?? null
  );
}

function isShiftEnter(e: KeyboardEvent): boolean {
  return (
    e.key === "Enter" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
  );
}

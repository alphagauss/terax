/** 使用 Shell 边界关联命令原文、网格标记和展示装饰，不从回显行数猜测布局。 */
import {
  createShellIntegrationState,
  registerCwdHandler,
} from "@/modules/terminal/lib/osc-handlers";
import { readSearchTokens } from "@/styles/tokens";
import type {
  IDecoration,
  IDecorationOptions,
  IMarker,
  Terminal,
} from "@xterm/xterm";
import { blockIndexAt, computeRange, type LineRange } from "./blockRange";
import {
  type BlockMode,
  initialModeState,
  type ModeState,
  modeOf,
  reduceMode,
} from "./modeMachine";
import { readRangeText } from "./readBlock";
import { searchRange, type BlockMatch } from "./searchBlock";
export type { BlockMatch } from "./searchBlock";
import type { BlockMeta } from "./types";

const OK_RULER = "#5fb3b3";
const FAIL_RULER = "#e5706b";
const MAX_BLOCKS = 1000;
// 按 UTF-16 字符数控制已完成输出的总占用；超限淘汰整份快照，不静默截断复制内容。
const MAX_SNAPSHOT_CHARS = 2 * 1024 * 1024;

type Entry = {
  id: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number;
  startMarker: IMarker;
  endMarker: IMarker;
  commandMarker: IMarker | null;
  deco: IDecoration | null;
  commandDeco: IDecoration | null;
  output: string | null;
};

type LiveBlock = {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  startMarker: IMarker;
  commandMarker: IMarker | null;
};

export type BlockContext = {
  command: string;
  cwd: string;
  exitCode: number | null;
  output: string;
};

export type PositionedBlock = {
  id: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  ok: boolean;
  startedAt: number;
  finishedAt: number;
  /** 命令首行在视口内时，在右侧操作槽显示入口。 */
  actionTop: number | null;
  actionHeight: number;
  canSearch: boolean;
};

export type VisibleBlocks = {
  blocks: PositionedBlock[];
  recent: PositionedBlock[];
  geometryVersion: number;
};

export type BlockDecorationsOptions = {
  onCwd?: (cwd: string) => void;
  onMode?: (mode: BlockMode) => void;
  onViewport?: () => void;
  takeSubmittedCommand?: () => string | null;
  /** ConPTY 缩放会重绘网格，旧标记无法继续保证对应原输出。 */
  invalidateOnResize?: boolean;
};

export class BlockDecorations {
  private readonly entries: Entry[] = [];
  private live: LiveBlock | null = null;
  private cwd = "";
  private idSeq = 0;
  private selectedId: string | null = null;
  private searchResources: {
    options: IDecorationOptions;
    decoration: IDecoration | undefined;
  }[] = [];
  private promptMarker: IMarker | null = null;
  private promptReady = false;
  private discardCurrentCommand = false;
  private reportedCommand: string | null = null;
  powershellInput = false;
  private mode: ModeState = initialModeState();
  private lastMode: BlockMode = modeOf(initialModeState());
  private readonly shellState = createShellIntegrationState();
  private readonly disposers: (() => void)[] = [];
  private readonly onCwd?: (cwd: string) => void;
  private readonly onMode?: (mode: BlockMode) => void;
  private readonly onViewport?: () => void;
  private readonly takeSubmittedCommand?: () => string | null;
  private viewportRaf: number | null = null;
  private snapshotChars = 0;
  private geometryVersion = 0;

  constructor(
    private readonly term: Terminal,
    opts?: BlockDecorationsOptions,
  ) {
    this.onCwd = opts?.onCwd;
    this.onMode = opts?.onMode;
    this.onViewport = opts?.onViewport;
    this.takeSubmittedCommand = opts?.takeSubmittedCommand;
    this.term.options.cursorInactiveStyle = "none";
    const osc133 = term.parser.registerOscHandler(133, (data) => {
      this.onOsc133(data);
      return true;
    });
    const cwd = registerCwdHandler(
      term,
      (c) => {
        this.cwd = c;
        this.onCwd?.(c);
      },
      this.shellState,
    );
    const parsed = term.onWriteParsed(() => this.syncAlt());
    const scroll = term.onScroll(() => this.scheduleViewport());
    const render = term.onRender(() => this.scheduleViewport());
    this.disposers.push(
      () => osc133.dispose(),
      cwd,
      () => parsed.dispose(),
      () => scroll.dispose(),
      () => render.dispose(),
    );
    const resize = term.onResize(() => {
      // 搜索结果保存物理行列，重排后不能继续导航旧坐标。
      this.geometryVersion++;
      this.clearSearch();
      if (opts?.invalidateOnResize) this.invalidateBlocks();
      else this.scheduleViewport();
    });
    this.disposers.push(() => resize.dispose());
  }

  /** ConPTY 重绘仅撤销网格定位，已完成命令仍可通过有界快照复制。 */
  private invalidateBlocks(): void {
    this.clearBlockSelection();
    for (const entry of this.entries) this.disposeEntry(entry);
    // 仅正在执行且已建立边界的命令失效，空闲和等待 Shell 接受的新提交不应被封锁。
    this.discardCurrentCommand ||= this.live !== null;
    this.live?.startMarker.dispose();
    this.live?.commandMarker?.dispose();
    this.live = null;
    this.promptMarker?.dispose();
    this.promptMarker = null;
    this.reportedCommand = null;
    this.scheduleViewport();
  }

  private scheduleViewport(): void {
    if (this.viewportRaf != null) return;
    this.viewportRaf = requestAnimationFrame(() => {
      this.viewportRaf = null;
      this.onViewport?.();
    });
  }

  syncAlt(): void {
    const alt = this.term.buffer.active.type === "alternate";
    if (alt === this.mode.altScreen) return;
    this.mode = reduceMode(this.mode, { type: "altScreen", active: alt });
    this.emitMode();
    this.scheduleViewport();
  }

  getBlocks(): BlockMeta[] {
    const out: BlockMeta[] = [];
    for (const e of this.entries) {
      const r = this.rangeOf(e);
      if (r) out.push(this.toMeta(e, r));
    }
    return out;
  }

  blockAt(line: number): BlockMeta | null {
    const ranges = this.entries.map((e) => this.rangeOf(e));
    const i = blockIndexAt(ranges, line);
    if (i < 0) return null;
    const r = ranges[i];
    return r ? this.toMeta(this.entries[i], r) : null;
  }

  readById(id: string): BlockContext | null {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return null;
    const r = this.rangeOf(e);
    const output =
      e.output ?? (r ? readRangeText(this.term, r.start, r.end) : null);
    if (output === null) return null;
    return {
      command: e.command,
      cwd: e.cwd,
      exitCode: e.exitCode,
      output,
    };
  }

  searchBlock(id: string, query: string): BlockMatch[] {
    const e = this.entries.find((x) => x.id === id);
    if (!e || !query) return [];
    const r = this.rangeOf(e);
    if (!r) return [];
    return searchRange(this.term.buffer.active, r.start, r.end, query);
  }

  revealMatch(m: BlockMatch): void {
    this.clearSearch();
    try {
      const buf = this.term.buffer.active;
      const backgroundColor = readSearchTokens().currentMatchBackground;
      this.term.scrollToLine(
        Math.max(0, m.line - Math.floor(this.term.rows / 2)),
      );
      for (const segment of m.segments) {
        const marker = this.term.registerMarker(
          segment.line - (buf.baseY + buf.cursorY),
        );
        if (!marker) continue;
        const options = {
          marker,
          x: segment.col,
          width: segment.len,
          backgroundColor,
        };
        const resource = {
          options,
          decoration: undefined as IDecoration | undefined,
        };
        this.searchResources.push(resource);
        resource.decoration = this.decorateSearchMatch(options);
      }
    } catch {}
  }

  /** 主题切换时重建当前命中的背景，不滚动或改变块搜索位置。 */
  refreshSearchTheme(): void {
    if (this.searchResources.length === 0) return;
    const backgroundColor = readSearchTokens().currentMatchBackground;
    for (const resource of this.searchResources) {
      // 复用随缓冲区裁剪移动的 marker，不能按初次搜索的行号重新定位。
      if (
        resource.options.marker.isDisposed ||
        resource.options.backgroundColor === backgroundColor
      )
        continue;
      resource.decoration?.dispose();
      resource.options = { ...resource.options, backgroundColor };
      resource.decoration = this.decorateSearchMatch(resource.options);
    }
  }

  private decorateSearchMatch(
    options: IDecorationOptions,
  ): IDecoration | undefined {
    // 背景交给网格绘制，避免不透明的 DOM 覆盖层遮住原文字。
    const decoration = this.term.registerDecoration(options);
    decoration?.onRender((el) => el.classList.add("bt-match"));
    return decoration;
  }

  clearSearch(): void {
    for (const resource of this.searchResources) {
      resource.decoration?.dispose();
      resource.options.marker.dispose();
    }
    this.searchResources = [];
  }

  beginSubmission(): boolean {
    if (!this.promptReady || modeOf(this.mode) !== "prompt") return false;
    this.discardCurrentCommand = false;
    this.captureCommandAnchor();
    this.promptReady = false;
    this.mode = reduceMode(this.mode, { type: "osc133", marker: "C" });
    this.emitMode();
    return true;
  }

  cancelSubmission(): void {
    this.promptReady = true;
    this.mode = reduceMode(this.mode, { type: "osc133", marker: "A" });
    this.emitMode();
  }

  hasAnyBlock(): boolean {
    return this.entries.length > 0 || this.live !== null;
  }

  visibleBlocks(): VisibleBlocks {
    if (this.mode.altScreen)
      return { blocks: [], recent: [], geometryVersion: this.geometryVersion };
    const blocks: PositionedBlock[] = [];
    const recent: PositionedBlock[] = [];
    const screen =
      this.term.element?.querySelector<HTMLElement>(".xterm-screen");
    // 装饰层直接提供 CSS 像素坐标，避免把受缩放影响的 DOMRect 再用于 CSS 定位。
    const offset =
      (this.term.element?.offsetTop ?? 0) + (screen?.offsetTop ?? 0);
    for (const e of this.entries) {
      const range = this.rangeOf(e);
      const block: PositionedBlock = {
        id: e.id,
        command: e.command,
        cwd: e.cwd,
        exitCode: e.exitCode,
        ok: e.exitCode === 0 || e.exitCode === null,
        startedAt: e.startedAt,
        finishedAt: e.finishedAt,
        actionTop: null,
        actionHeight: 24,
        canSearch: range !== null,
      };
      if (range || e.output !== null) recent.push(block);
      if (!range) continue;
      const element = e.commandDeco?.element;
      if (!element || element.style.display === "none") continue;
      const rowTop = Number.parseFloat(element.style.top);
      const rowHeight = Number.parseFloat(element.style.lineHeight);
      if (!Number.isFinite(rowTop) || !Number.isFinite(rowHeight)) continue;
      const actionHeight = Math.max(24, rowHeight);
      blocks.push({
        ...block,
        actionTop: Math.max(
          offset,
          offset + rowTop + (rowHeight - actionHeight) / 2,
        ),
        actionHeight,
      });
    }
    return {
      blocks,
      recent: recent.slice(-20).reverse(),
      geometryVersion: this.geometryVersion,
    };
  }

  selectBlockAt(clientY: number): void {
    const screen =
      this.term.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || this.term.rows === 0) return;
    const rect = screen.getBoundingClientRect();
    const cellHeight = rect.height / this.term.rows;
    if (cellHeight <= 0) return;
    const row = Math.floor((clientY - rect.top) / cellHeight);
    const bufferRow = this.term.buffer.active.viewportY + row;
    const block = this.blockAt(bufferRow);
    if (!block) {
      this.clearBlockSelection();
      return;
    }
    if (block.id === this.selectedId && this.term.hasSelection()) {
      this.clearBlockSelection();
      return;
    }
    this.selectBlock(block.id);
  }

  selectBlock(id: string): void {
    const e = this.entries.find((x) => x.id === id);
    const r = e ? this.rangeOf(e) : null;
    if (!r) return;
    if (r.end < r.start) {
      this.clearBlockSelection();
      return;
    }
    this.term.selectLines(r.start, r.end);
    this.selectedId = id;
  }

  clearBlockSelection(): boolean {
    const had = this.term.hasSelection();
    this.term.clearSelection();
    this.selectedId = null;
    return had;
  }

  // Steps relative to the selected block when one is selected, otherwise
  // starts from the most recent block.
  navigateBlocks(dir: -1 | 1): void {
    if (this.entries.length === 0) return;
    let idx: number;
    const cur = this.selectedId
      ? this.entries.findIndex((e) => e.id === this.selectedId)
      : -1;
    if (cur >= 0 && this.term.hasSelection()) {
      idx = cur + dir;
    } else {
      idx = dir < 0 ? this.entries.length - 1 : -1;
    }
    while (idx >= 0 && idx < this.entries.length) {
      const e = this.entries[idx];
      const r = this.rangeOf(e);
      if (r && r.end >= r.start) {
        this.term.selectLines(r.start, r.end);
        this.selectedId = e.id;
        this.term.scrollToLine(Math.max(0, r.start - 2));
        return;
      }
      idx += dir;
    }
  }

  dispose(): void {
    if (this.viewportRaf != null) cancelAnimationFrame(this.viewportRaf);
    this.clearSearch();
    for (const e of this.entries) this.disposeEntry(e);
    this.entries.length = 0;
    this.snapshotChars = 0;
    this.live?.startMarker.dispose();
    this.live?.commandMarker?.dispose();
    this.promptMarker?.dispose();
    this.live = null;
    for (const d of this.disposers) {
      try {
        d();
      } catch {}
    }
    this.disposers.length = 0;
  }

  private rangeOf(e: Entry): LineRange | null {
    return computeRange(e.startMarker, e.endMarker);
  }

  private toMeta(e: Entry, r: LineRange): BlockMeta {
    return {
      id: e.id,
      command: e.command,
      cwd: e.cwd,
      exitCode: e.exitCode,
      startLine: r.start,
      endLine: r.end,
      startedAt: e.startedAt,
      finishedAt: e.finishedAt,
    };
  }

  private emitMode(): void {
    const m = modeOf(this.mode);
    if (m === this.lastMode) return;
    this.lastMode = m;
    this.onMode?.(m);
  }

  private onOsc133(data: string): void {
    const marker = data[0];
    const rest = data.length > 2 && data[1] === ";" ? data.slice(2) : "";
    switch (marker) {
      case "A":
        this.discardCurrentCommand = false;
        this.reportedCommand = null;
        this.promptReady = false;
        this.takeSubmittedCommand?.();
        this.shellState.inCommand = false;
        this.mode = reduceMode(this.mode, { type: "osc133", marker: "A" });
        break;
      case "B":
        this.discardCurrentCommand = false;
        this.promptReady = true;
        this.powershellInput = rest === "terax=powershell";
        this.captureCommandAnchor();
        this.shellState.inCommand = true;
        this.mode = reduceMode(this.mode, { type: "osc133", marker: "B" });
        break;
      case "C":
        this.promptReady = false;
        this.shellState.inCommand = true;
        this.mode = reduceMode(this.mode, { type: "osc133", marker: "C" });
        this.startBlock();
        break;
      case "E":
        try {
          this.reportedCommand = decodeURIComponent(rest);
        } catch {
          this.reportedCommand = null;
        }
        break;
      case "D":
        this.shellState.inCommand = false;
        this.finishBlock(rest);
        this.discardCurrentCommand = false;
        this.mode = reduceMode(this.mode, { type: "osc133", marker: "D" });
        break;
    }
    this.emitMode();
  }

  /** 新提交本身就是新的锚点，不依赖 Shell 在 resize 后重新报告提示符。 */
  private captureCommandAnchor(): void {
    this.promptMarker?.dispose();
    const buf = this.term.buffer.active;
    const cursorLine = buf.baseY + buf.cursorY;
    let commandLine = cursorLine;
    while (commandLine > 0 && buf.getLine(commandLine)?.isWrapped)
      commandLine--;
    this.promptMarker =
      this.term.registerMarker(commandLine - cursorLine) ?? null;
  }

  private startBlock(): void {
    if (this.discardCurrentCommand) return;
    // Bash 的一次多行提交可在同一个 D 前产生多个 PS0/C，仍属于同一命令块。
    if (this.live) {
      this.reportedCommand = null;
      return;
    }
    const marker = this.term.registerMarker(0);
    if (!marker) return;
    this.live = {
      id: `b${++this.idSeq}`,
      command: this.takeSubmittedCommand?.() ?? this.reportedCommand ?? "",
      cwd: this.cwd,
      startedAt: Date.now(),
      startMarker: marker,
      commandMarker: this.promptMarker ?? this.term.registerMarker(0) ?? null,
    };
    this.promptMarker = null;
    this.reportedCommand = null;
    this.scheduleViewport();
  }

  private finishBlock(codeStr: string): void {
    const lb = this.live;
    if (!lb) return;
    this.live = null;
    if (lb.startMarker.isDisposed) {
      lb.commandMarker?.dispose();
      return;
    }
    const exit = parseExitCode(codeStr);
    const ok = exit === 0 || exit === null;
    // D 所在行只有存在内容或未归零的光标时才属于输出，不用空白文本反推命令边界。
    const buf = this.term.buffer.active;
    const cursorLine = buf.baseY + buf.cursorY;
    const includesCursorLine =
      buf.cursorX > 0 || !!buf.getLine(cursorLine)?.translateToString(true);
    const endMarker = this.term.registerMarker(includesCursorLine ? 1 : 0);
    if (!endMarker) {
      lb.startMarker.dispose();
      lb.commandMarker?.dispose();
      return;
    }
    // 分隔线与概览标记共用输出结束边界，行高、重排及裁剪由 xterm 原生装饰层负责。
    const deco =
      this.term.registerDecoration({
        marker: endMarker,
        width: 1,
        overviewRulerOptions: { color: ok ? OK_RULER : FAIL_RULER },
      }) ?? null;
    deco?.onRender((element) => {
      element.classList.add("bt-output-boundary");
      element.classList.toggle("bt-output-boundary-fail", !ok);
      element.style.width = "100%";
    });
    const commandDeco = lb.commandMarker
      ? (this.term.registerDecoration({ marker: lb.commandMarker, width: 1 }) ??
        null)
      : null;
    commandDeco?.onRender(() => this.scheduleViewport());
    const output = readRangeText(
      this.term,
      lb.startMarker.line,
      endMarker.line - 1,
    );
    this.entries.push({
      id: lb.id,
      command: lb.command,
      cwd: lb.cwd,
      exitCode: exit,
      startedAt: lb.startedAt,
      finishedAt: Date.now(),
      startMarker: lb.startMarker,
      endMarker,
      commandMarker: lb.commandMarker,
      deco,
      commandDeco,
      output: output.length <= MAX_SNAPSHOT_CHARS ? output : null,
    });
    if (output.length <= MAX_SNAPSHOT_CHARS)
      this.snapshotChars += output.length;
    for (const entry of this.entries) {
      if (this.snapshotChars <= MAX_SNAPSHOT_CHARS) break;
      this.snapshotChars -= entry.output?.length ?? 0;
      entry.output = null;
    }
    while (this.entries.length > MAX_BLOCKS) {
      const old = this.entries.shift();
      if (old) {
        this.snapshotChars -= old.output?.length ?? 0;
        this.disposeEntry(old);
      }
    }
    this.scheduleViewport();
  }

  private disposeEntry(e: Entry): void {
    e.commandDeco?.dispose();
    e.commandDeco = null;
    e.commandMarker?.dispose();
    e.commandMarker = null;
    try {
      e.deco?.dispose();
    } catch {}
    // 已完成快照继续留在历史里，但不能持有已从页面移除的装饰 DOM。
    e.deco = null;
    try {
      e.startMarker.dispose();
    } catch {}
    try {
      e.endMarker.dispose();
    } catch {}
  }
}

function parseExitCode(s: string): number | null {
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

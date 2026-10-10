import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockDecorations } from "./blockDecorations";

type OscHandler = (data: string) => boolean | Promise<boolean>;

// BlockDecorations schedules viewport updates via rAF; the headless test env
// has none, and we don't assert on viewport geometry, so a no-op is enough.
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// Minimal headless fake of the xterm surface BlockDecorations touches. Markers
// report whatever line was last set, so a test can place C/D at chosen rows.
function makeFakeTerm() {
  const handlers = new Map<number, OscHandler>();
  let currentLine = 0;
  let selection: [number, number] | null = null;
  let scrolledTo: number | null = null;
  const term = {
    options: {} as Record<string, unknown>,
    element: null,
    parser: {
      registerOscHandler(code: number, h: OscHandler) {
        handlers.set(code, h);
        return { dispose: () => handlers.delete(code) };
      },
    },
    registerMarker: vi.fn((offset = 0) => ({
      line: currentLine + offset,
      isDisposed: false,
      dispose: vi.fn(),
    })),
    registerDecoration: vi.fn(() => ({ dispose: vi.fn(), onRender: vi.fn() })),
    onWriteParsed: vi.fn(() => ({ dispose: vi.fn() })),
    onScroll: vi.fn(() => ({ dispose: vi.fn() })),
    onRender: vi.fn(() => ({ dispose: vi.fn() })),
    hasSelection: () => selection !== null,
    selectLines: (start: number, end: number) => {
      selection = [start, end];
    },
    clearSelection: () => {
      selection = null;
    },
    scrollToLine: (line: number) => {
      scrolledTo = line;
    },
    buffer: {
      active: {
        type: "normal",
        length: 5000,
        baseY: 0,
        cursorY: 0,
        viewportY: 0,
        getLine: () => ({ translateToString: () => "" }),
      },
    },
  } as unknown as Terminal;
  return {
    term,
    emit: (payload: string) => handlers.get(133)?.(payload),
    setLine: (n: number) => {
      currentLine = n;
    },
    getSelection: () => selection,
    getScrolledTo: () => scrolledTo,
  };
}

describe("BlockDecorations — OSC 133 block lifecycle", () => {
  it("用提交原文关联 Bash 无命令标记，并阻止重复提交", () => {
    const { term, emit, setLine } = makeFakeTerm();
    let submitted: string | null = null;
    const onMode = vi.fn();
    const deco = new BlockDecorations(term, {
      onMode,
      takeSubmittedCommand: () => {
        const text = submitted;
        submitted = null;
        return text;
      },
    });
    expect(deco.beginSubmission()).toBe(false);
    setLine(1);
    emit("B");
    expect(deco.beginSubmission()).toBe(true);
    expect(onMode).toHaveBeenLastCalledWith("running");
    expect(deco.beginSubmission()).toBe(false);
    const command = `echo '${"长命令".repeat(100)}'\necho done`;
    submitted = command;
    setLine(9);
    emit("C");
    emit("D;0");
    expect(deco.getBlocks()[0].command).toBe(command);
    expect(onMode).toHaveBeenLastCalledWith("prompt");
    deco.dispose();
  });

  it("按 B 锚点定位标题，多行回显和缩放不推移标题", () => {
    const { term, emit, setLine } = makeFakeTerm();
    const screenRect = { top: 100, height: 400 };
    Object.assign(term, {
      rows: 20,
      element: {
        querySelector: () => ({ getBoundingClientRect: () => screenRect }),
        getBoundingClientRect: () => ({ top: 100 }),
      },
    });
    const deco = new BlockDecorations(term);
    setLine(2);
    emit("B;terax=powershell");
    expect(deco.powershellInput).toBe(true);
    setLine(12);
    const command = "Write-Output '你好'\nWrite-Output 'two'";
    emit(`E;${encodeURIComponent(command)}`);
    emit("C;preview");
    setLine(15);
    emit("D;0");
    expect(deco.getBlocks()[0].command).toBe(command);
    expect(deco.visibleBlocks().blocks[0].headerTop).toBe(20);
    screenRect.height = 600;
    expect(deco.visibleBlocks().blocks[0].headerTop).toBe(30);
    deco.dispose();
  });
  it("creates a finished block on C..D with command, exit code and range", () => {
    const { term, emit, setLine } = makeFakeTerm();
    const deco = new BlockDecorations(term);
    setLine(5);
    emit("E;ls%20-al");
    emit("C;ls -al");
    setLine(9);
    emit("D;0");
    const blocks = deco.getBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].command).toBe("ls -al");
    expect(blocks[0].exitCode).toBe(0);
    expect(blocks[0].startLine).toBe(5);
    expect(blocks[0].endLine).toBe(9);
  });

  it("records a non-zero exit code", () => {
    const { term, emit, setLine } = makeFakeTerm();
    const deco = new BlockDecorations(term);
    setLine(2);
    emit("C;false");
    emit("D;1");
    expect(deco.getBlocks()[0].exitCode).toBe(1);
  });

  it("keeps no finished block while a command is still running", () => {
    const { term, emit, setLine } = makeFakeTerm();
    const deco = new BlockDecorations(term);
    setLine(1);
    emit("C;sleep 10");
    expect(deco.getBlocks()).toHaveLength(0);
  });

  it("同一次多行提交的多个 C 在 D 到达前保持同一命令块", () => {
    const { term, emit, setLine } = makeFakeTerm();
    const deco = new BlockDecorations(term);
    setLine(1);
    emit("E;first");
    emit("C;first");
    setLine(3);
    emit("E;second");
    emit("C;second");
    expect(deco.getBlocks()).toHaveLength(0);
    setLine(5);
    emit("D;0");
    const blocks = deco.getBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].command).toBe("first");
    expect(blocks[0].exitCode).toBe(0);
    expect(blocks[0].startLine).toBe(1);
    expect(blocks[0].endLine).toBe(5);
  });

  it("ignores a D that arrives with no live block", () => {
    const { term, emit } = makeFakeTerm();
    const deco = new BlockDecorations(term);
    emit("D;0");
    expect(deco.getBlocks()).toHaveLength(0);
  });

  it("reports hasAnyBlock for live and finished blocks", () => {
    const { term, emit, setLine } = makeFakeTerm();
    const deco = new BlockDecorations(term);
    expect(deco.hasAnyBlock()).toBe(false);
    setLine(1);
    emit("C;ls");
    expect(deco.hasAnyBlock()).toBe(true);
    emit("D;0");
    expect(deco.hasAnyBlock()).toBe(true);
  });

  it("caps history at MAX_BLOCKS, dropping the oldest", () => {
    const { term, emit, setLine } = makeFakeTerm();
    const deco = new BlockDecorations(term);
    for (let i = 0; i < 1005; i++) {
      setLine(i);
      emit(`E;cmd${i}`);
      emit(`C;cmd${i}`);
      emit("D;0");
    }
    const blocks = deco.getBlocks();
    expect(blocks).toHaveLength(1000);
    expect(blocks[0].command).toBe("cmd5");
    expect(blocks[blocks.length - 1].command).toBe("cmd1004");
  });
});

describe("BlockDecorations — selection and navigation", () => {
  function withBlocks(count: number) {
    const fake = makeFakeTerm();
    const deco = new BlockDecorations(fake.term);
    for (let i = 0; i < count; i++) {
      fake.setLine(i * 10);
      fake.emit(`C;cmd${i}`);
      fake.setLine(i * 10 + 5);
      fake.emit("D;0");
    }
    return { ...fake, deco };
  }

  it("selectBlock selects the block range and clearBlockSelection drops it", () => {
    const { deco, getSelection } = withBlocks(2);
    const id = deco.getBlocks()[0].id;
    deco.selectBlock(id);
    expect(getSelection()).toEqual([0, 5]);
    expect(deco.clearBlockSelection()).toBe(true);
    expect(getSelection()).toBeNull();
    expect(deco.clearBlockSelection()).toBe(false);
  });

  it("navigateBlocks starts at the most recent block and steps backwards", () => {
    const { deco, getSelection, getScrolledTo } = withBlocks(3);
    deco.navigateBlocks(-1);
    expect(getSelection()).toEqual([20, 25]);
    expect(getScrolledTo()).toBe(18);
    deco.navigateBlocks(-1);
    expect(getSelection()).toEqual([10, 15]);
    deco.navigateBlocks(1);
    expect(getSelection()).toEqual([20, 25]);
  });

  it("navigateBlocks stops at the edges", () => {
    const { deco, getSelection } = withBlocks(2);
    deco.navigateBlocks(-1);
    deco.navigateBlocks(-1);
    deco.navigateBlocks(-1);
    expect(getSelection()).toEqual([0, 5]);
    deco.navigateBlocks(1);
    deco.navigateBlocks(1);
    deco.navigateBlocks(1);
    expect(getSelection()).toEqual([10, 15]);
  });

  it("navigateBlocks is a no-op with no blocks", () => {
    const { term } = makeFakeTerm();
    const deco = new BlockDecorations(term);
    expect(() => deco.navigateBlocks(-1)).not.toThrow();
  });
});

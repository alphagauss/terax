import {
  configureRendererPool,
  flushSlotResize,
  type Slot,
  pasteIntoTerminal,
  visibleBindingsRequireAnotherSlot,
} from "@/modules/terminal/lib/rendererPool";
import { describe, expect, it, vi } from "vitest";

it.each([false, true])(
  "提交前等待尺寸确认且不覆盖复用后的渲染器：rebind=%s",
  async (rebind) => {
    let complete!: () => void;
    const events: string[] = [];
    const resize = vi.fn(() => {
      events.push("resize");
      return new Promise<void>((resolve) => {
        complete = resolve;
      });
    });
    const staleResize = vi.fn();
    const grid = { cols: 80, rows: 20 };
    const slot = {
      currentTerminalId: 1,
      fitTimer: setTimeout(staleResize, 0),
      ptyTimer: setTimeout(staleResize, 0),
      term: grid,
      lastCols: 80,
      lastRows: 20,
      host: { parentElement: { clientWidth: 800, clientHeight: 600 } },
      fitAddon: {
        fit: () => {
          events.push("fit");
          grid.rows = 30;
        },
      },
    } as unknown as Slot;
    configureRendererPool({
      resolveTerminal: () => ({
        resizePty: resize,
        writeToPty: vi.fn(),
        kickPty: vi.fn(),
      }),
      evictTerminal: vi.fn(),
      isTerminalFocused: () => true,
      isTerminalBlocks: () => true,
      isTerminalBusy: () => false,
      isTerminalVisible: () => true,
      storeSnapshot: vi.fn(),
    });
    const pending = flushSlotResize(slot).then(() => events.push("ready"));
    expect(events).toEqual(["fit", "resize"]);
    expect(resize).toHaveBeenCalledWith(80, 30);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(staleResize).not.toHaveBeenCalled();
    expect(events).not.toContain("ready");
    if (rebind) {
      slot.currentTerminalId = 2;
      slot.lastRows = 40;
    }
    complete();
    await pending;
    expect(slot.lastRows).toBe(rebind ? 40 : 30);
    expect(events).toEqual(["fit", "resize", "ready"]);
  },
);

describe("renderer pool visibility policy", () => {
  it("grows when every existing renderer belongs to a visible terminal", () => {
    expect(
      visibleBindingsRequireAnotherSlot([
        { bound: true, visible: true },
        { bound: true, visible: true },
      ]),
    ).toBe(true);
  });

  it("reuses a slot when a hidden or unbound renderer exists", () => {
    expect(
      visibleBindingsRequireAnotherSlot([
        { bound: true, visible: true },
        { bound: true, visible: false },
      ]),
    ).toBe(false);
    expect(
      visibleBindingsRequireAnotherSlot([
        { bound: true, visible: true },
        { bound: false, visible: false },
      ]),
    ).toBe(false);
  });
});

it("块终端的编辑入口接收完整粘贴，不依赖或重新分配 xterm 渲染器", () => {
  const paste = vi.fn().mockReturnValue(true);
  const adapter = {
    pasteIntoInput: paste,
    resolveTerminal: () => null,
    evictTerminal: vi.fn(),
    isTerminalFocused: () => true,
    isTerminalBlocks: () => true,
    isTerminalBusy: () => false,
    isTerminalVisible: () => true,
    storeSnapshot: vi.fn(),
  };
  configureRendererPool(adapter);
  expect(pasteIntoTerminal(7, "'/host/a b.png' ")).toBe(true);
  expect(paste).toHaveBeenCalledWith(7, "'/host/a b.png' ");
  paste.mockReturnValue(false);
  expect(pasteIntoTerminal(8, "text")).toBe(false);
  configureRendererPool({ ...adapter, pasteIntoInput: undefined });
});

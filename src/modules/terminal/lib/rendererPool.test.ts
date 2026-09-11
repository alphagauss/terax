import {
  configureRendererPool,
  pasteIntoTerminal,
  visibleBindingsRequireAnotherSlot,
} from "@/modules/terminal/lib/rendererPool";
import { describe, expect, it, vi } from "vitest";

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

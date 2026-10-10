// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BlockOverlay } from "./BlockOverlay";
import type { PositionedBlock, VisibleBlocks } from "./lib/blockDecorations";

const copy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: copy }));
vi.mock("@/modules/ai/store/chatStore", () => ({
  useChatStore: { getState: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

it("缩放关闭过期搜索，最近命令复用菜单复制快照，TUI 隐藏浮层", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const block: PositionedBlock = {
    id: "b1",
    command: "echo original",
    cwd: "/project",
    exitCode: 0,
    ok: true,
    startedAt: 1,
    finishedAt: 2,
    actionTop: 10,
    actionHeight: 24,
    canSearch: true,
  };
  let visible: VisibleBlocks = {
    blocks: [block],
    recent: [block],
    geometryVersion: 0,
  };
  let update = () => {};
  const props = {
    subscribe: (cb: () => void) => {
      update = cb;
      return () => {};
    },
    getVisible: () => visible,
    readOutput: () => "original",
    searchBlock: () => [],
    revealMatch: vi.fn(),
    clearSearch: vi.fn(),
    promptReady: true,
    onRunAgain: vi.fn(),
    onRestoreFocus: vi.fn(),
  };
  const byText = (selector: string, text: string) => {
    const element = [...document.querySelectorAll<HTMLElement>(selector)].find(
      (el) => el.textContent === text,
    );
    expect(element).toBeDefined();
    return element as HTMLElement;
  };
  const key = async (element: HTMLElement, value: string) => {
    await act(async () => {
      element.focus();
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: value, bubbles: true }),
      );
    });
  };
  try {
    await act(async () => root.render(<BlockOverlay {...props} />));
    await key(
      container.querySelector('[aria-label="block.actions"]') as HTMLElement,
      "Enter",
    );
    await act(async () =>
      byText('[role="menuitem"]', "block.findInBlock").click(),
    );
    expect(container.querySelector("input")).not.toBeNull();

    visible = {
      blocks: [],
      recent: [{ ...block, actionTop: null, canSearch: false }],
      geometryVersion: 1,
    };
    await act(async () => update());
    expect(container.querySelector("input")).toBeNull();
    expect(props.clearSearch).toHaveBeenCalled();

    await key(byText("button", "block.recent"), "Enter");
    await key(
      document.querySelector(
        '[data-slot="dropdown-menu-sub-trigger"]',
      ) as HTMLElement,
      "ArrowRight",
    );
    expect(
      byText('[role="menuitem"]', "block.findInBlock").hasAttribute(
        "data-disabled",
      ),
    ).toBe(true);
    await act(async () =>
      byText('[role="menuitem"]', "block.copyOutput").click(),
    );
    expect(copy).toHaveBeenCalledWith("original");

    await key(byText("button", "block.recent"), "Enter");
    await act(async () => root.render(<BlockOverlay {...props} hidden />));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

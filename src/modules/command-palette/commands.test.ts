import { describe, expect, it, vi } from "vitest";
import {
  type CommandPaletteActionContext,
  createCommandItems,
} from "./commands";

function context(): CommandPaletteActionContext {
  const noop = vi.fn();
  return {
    tabs: [],
    activeId: 0,
    searchTarget: null,
    explorerRoot: null,
    home: null,
    openNewWindow: noop,
    workspaceWindowMode: "multiple",
    openNewTab: noop,
    openNewBlock: noop,
    openNewPrivate: noop,
    openNewEditor: noop,
    openNewWebPreview: noop,
    openGitGraph: noop,
    toggleSourceControl: noop,
    closeActiveTab: noop,
    splitGroupRight: noop,
    splitGroupDown: noop,
    focusSearch: noop,
    focusExplorerSearch: noop,
    toggleSidebar: noop,
    toggleAi: noop,
    askAiSelection: noop,
    openSettings: noop,
    openKeyboardShortcuts: noop,
    spaces: [],
    activeSpaceId: null,
    openSpacesOverview: noop,
    newSpace: noop,
    switchSpace: noop,
  };
}

describe("command palette commands", () => {
  it("places New Window first and wires its handler", () => {
    const ctx = context();
    const items = createCommandItems(ctx);
    expect(items[0]?.id).toBe("window.new");
    expect(items[0]?.shortcutId).toBe("window.new");
    items[0]?.run();
    expect(ctx.openNewWindow).toHaveBeenCalledOnce();
  });

  it("hides New Window in single-window mode", () => {
    const ctx = context();
    ctx.workspaceWindowMode = "single";
    expect(
      createCommandItems(ctx).some((item) => item.id === "window.new"),
    ).toBe(false);
  });
});

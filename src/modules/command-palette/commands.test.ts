import { describe, expect, it, vi } from "vitest";
import { createCommandItems, type CommandPaletteActionContext } from "./commands";

function context(): CommandPaletteActionContext {
  const noop = vi.fn();
  return {
    tabs: [],
    activeId: 0,
    searchTarget: null,
    explorerRoot: null,
    home: null,
    openNewWindow: noop,
    openNewTab: noop,
    openNewBlock: noop,
    openNewPrivate: noop,
    openNewEditor: noop,
    openNewPreview: noop,
    openGitGraph: noop,
    toggleSourceControl: noop,
    closeActiveTabOrPane: noop,
    splitPaneRight: noop,
    splitPaneDown: noop,
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
});

/**
 * 本文件测试命令面板动作的可用性、排序和回调连接。
 * 运行时上下文使用完整假动作，避免新增视图命令破坏既有命令构建。
 */

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
    canFind: false,
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
    toggleHiddenFiles: noop,
    setActivityBarPosition: noop,
    setActivityBarSize: noop,
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
  it("allows copying a dirty document view", () => {
    const ctx = context();
    ctx.tabs = [
      {
        id: 1,
        kind: "editor",
        spaceId: "space-a",
        title: "file.ts",
        path: "file.ts",
        dirty: true,
        preview: false,
      },
    ];
    ctx.activeId = 1;

    const split = createCommandItems(ctx).find(
      (item) => item.id === "workbench.splitRight",
    );
    expect(split?.disabledReason).toBeUndefined();
  });

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

  it("根据当前视图状态禁用拆分、关闭和搜索", () => {
    const ctx = context();
    const items = createCommandItems(ctx);
    const reason = (id: string) =>
      items.find((item) => item.id === id)?.disabledReason;

    expect(reason("workbench.splitRight")).toBeDefined();
    expect(reason("workbench.splitDown")).toBeDefined();
    expect(reason("tab.close")).toBe("Last tab");
    expect(reason("search.focus")).toBeDefined();
    expect(reason("explorer.search")).toBeDefined();
  });

  it("为活动 Space 标记当前状态", () => {
    const ctx = context();
    ctx.spaces = [{ id: "space-a", name: "One" }];
    ctx.activeSpaceId = "space-a";
    const item = createCommandItems(ctx).find(
      (candidate) => candidate.id === "spaces.switch.space-a",
    );
    expect(item?.disabledReason).toBe("Current space");
  });

  it("连接显示隐藏文件命令及其快捷键", () => {
    const ctx = context();
    const item = createCommandItems(ctx).find(
      (candidate) => candidate.id === "explorer.toggleHidden",
    );

    expect(item?.shortcutId).toBe("explorer.toggleHidden");
    item?.run();
    expect(ctx.toggleHiddenFiles).toHaveBeenCalledOnce();
  });
});
